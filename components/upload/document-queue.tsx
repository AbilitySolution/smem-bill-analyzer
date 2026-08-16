"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle, Archive, CheckCircle2, CheckSquare, Clock3, ExternalLink, FileText,
  FolderOpen, Loader2, RefreshCw, Search, Square, Trash2, UploadCloud, X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  BATCH_JOBS_PER_INVOCATION, DIRECT_DOCUMENT_LIMIT, DIRECT_JOBS_PER_INVOCATION,
  MAX_ARCHIVE_SIZE, MAX_FILES, MAX_FILE_SIZE, MAX_TOTAL_SIZE,
  chunkForUpload, detectDocumentType, extensionOf, mimeTypeFromName, processingModeFor,
} from "@/lib/documents/queue";
import {
  estimateForDocumentCount, estimateRemainingForJobs, type ProcessingEstimateStats,
} from "@/lib/documents/processing-estimate";
import { isTerminalJobStatus, type DocumentJob, type DocumentJobStatus } from "@/lib/types/document-job";

type AutoSavedEntry = { jobId: string; invoiceId: string; factureNumber: string; lowConfidence: boolean };
type DuplicateEntry = { jobId: string; existingInvoiceId: string; factureNumber: string };
type ToReviewEntry = { jobId: string; factureNumber: string; reason: string };

/** Filet si Realtime décroche : on ne sonde que si l'onglet est visible ET qu'il reste du travail. */
const FALLBACK_REFRESH_MS = 60_000;
/** Suivi du dernier dépôt, conservé pour survivre à un rechargement de page. */
const ACTIVE_UPLOAD_STORAGE_KEY = "smem-active-document-job-ids";
/**
 * Fenêtre de repli quand le suivi du dernier dépôt est perdu (localStorage vidé, dépôt
 * fait depuis un autre poste). On suit alors les jobs récents — terminés compris, sinon
 * la barre de progression ne peut jamais avancer : un document qui finit sortirait du
 * dénominateur au lieu de compter comme fait.
 */
const RECENT_TRACKING_WINDOW_MS = 2 * 60 * 60 * 1000;
/** Documents enregistrés automatiquement par appel : borne la durée d'une requête. */
const AUTO_SAVE_CHUNK = 25;
/**
 * Durée pendant laquelle « Traitement terminé » reste affiché après le dernier document.
 * Au-delà, le dépôt cesse d'être suivi : sans cette expiration, `activeUploadJobIds`
 * n'était jamais relâché — les jobs existent toujours une fois terminés, la purge de
 * `refreshJobs` ne retire que les identifiants inconnus — et le panneau restait à
 * l'écran indéfiniment, rechargements compris puisque la liste est en localStorage.
 */
const FINISHED_PANEL_GRACE_MS = 5 * 60 * 1000;

type RealtimeStatus = "connecting" | "live" | "recovering";

/** Horodatage de la dernière écriture parmi ces jobs. 0 si la liste est vide. */
function lastActivityOf(jobs: DocumentJob[]): number {
  return jobs.reduce((latest, job) => {
    const updatedAt = Date.parse(job.updated_at);
    return Number.isFinite(updatedAt) && updatedAt > latest ? updatedAt : latest;
  }, 0);
}

function isZip(file: File) {
  return file.type === "application/zip"
    || file.type === "application/x-zip-compressed"
    || extensionOf(file.name) === "zip";
}

const statusLabel: Record<DocumentJobStatus, string> = {
  direct_queued: "En attente",
  direct_processing: "Extraction en cours",
  queued: "En attente",
  uploading_to_claude: "Préparation",
  batched: "Extraction en cours",
  processing: "Extraction en cours",
  needs_review: "À réviser",
  completed: "Terminé",
  failed: "Échec",
  rejected_non_invoice: "Ignoré (pas une facture)",
};

const prefilterTypeLabel: Record<string, string> = {
  bordereau_recapitulatif: "bordereau récapitulatif",
  autre: "document non reconnu comme facture",
  facture: "facture",
};

/**
 * Regroupement des statuts en quelques catégories lisibles pour les puces de filtre.
 * Plusieurs statuts partagent le même libellé affiché (`statusLabel`) — filtrer sur le
 * statut brut ferait apparaître deux puces identiques ("En attente" ×2).
 */
type QueueBucket = "waiting" | "processing" | "needs_review" | "failed" | "rejected";
const BUCKET_OF: Record<DocumentJobStatus, QueueBucket> = {
  queued: "waiting",
  direct_queued: "waiting",
  uploading_to_claude: "processing",
  direct_processing: "processing",
  batched: "processing",
  processing: "processing",
  needs_review: "needs_review",
  // Jamais rencontré ici : `queueJobs` exclut déjà `completed`. Présent pour l'exhaustivité du Record.
  completed: "processing",
  failed: "failed",
  rejected_non_invoice: "rejected",
};
const BUCKET_LABEL: Record<QueueBucket, string> = {
  waiting: "En attente",
  processing: "En cours",
  needs_review: "À réviser",
  failed: "Échec",
  rejected: "Ignorés",
};
const BUCKET_ORDER: QueueBucket[] = ["waiting", "processing", "needs_review", "failed", "rejected"];

/**
 * Au-delà, les barres de recherche/filtre et la virtualisation apparaissent — inutile
 * pour un dépôt de quelques fichiers, le cas le plus fréquent.
 */
const LARGE_LIST_THRESHOLD = 20;

const fmt = (n: number) => n.toLocaleString("fr-FR");

/** Deux `File` du navigateur désignent le même document sélectionné. */
function sameFile(a: File, b: File) {
  return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
}

export function DocumentQueue({ orgId }: { orgId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [jobs, setJobs] = useState<DocumentJob[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [estimationStats, setEstimationStats] = useState<ProcessingEstimateStats | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("connecting");
  const [activeUploadJobIds, setActiveUploadJobIds] = useState<string[]>([]);
  const [selectedReviewJobIds, setSelectedReviewJobIds] = useState<Set<string>>(new Set());
  const [deletingReviewJobs, setDeletingReviewJobs] = useState(false);
  const [deletingAllJobs, setDeletingAllJobs] = useState(false);
  const [retryingRejected, setRetryingRejected] = useState(false);
  const [fileSearch, setFileSearch] = useState("");
  const [queueSearch, setQueueSearch] = useState("");
  const [queueBucketFilter, setQueueBucketFilter] = useState<QueueBucket | "all">("all");
  const fileListParentRef = useRef<HTMLDivElement>(null);
  const queueListParentRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  /** Incrémenté par « Actualiser » : relance aussi l'enregistrement automatique en échec. */
  const [manualSyncCount, setManualSyncCount] = useState(0);
  const jobsRef = useRef<DocumentJob[]>([]);
  const [autoResult, setAutoResult] = useState<{ autoSaved: AutoSavedEntry[]; toReview: ToReviewEntry[]; duplicates: DuplicateEntry[] }>({ autoSaved: [], toReview: [], duplicates: [] });
  const autoProcessedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // `webkitdirectory` n'existe pas dans les types React : posé à la main après montage.
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    folderInputRef.current?.setAttribute("directory", "");
    const restoreStoredJobs = window.setTimeout(() => {
      try {
        const stored = JSON.parse(window.localStorage.getItem(ACTIVE_UPLOAD_STORAGE_KEY) ?? "[]");
        if (Array.isArray(stored)) setActiveUploadJobIds(stored.filter((id): id is string => typeof id === "string"));
      } catch {
        window.localStorage.removeItem(ACTIVE_UPLOAD_STORAGE_KEY);
      }
    }, 0);
    return () => window.clearTimeout(restoreStoredJobs);
  }, []);

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  const refreshJobs = useCallback(async () => {
    const response = await fetch("/api/document-jobs", { cache: "no-store" }).catch(() => null);
    if (!response?.ok) return null;
    const payload = await response.json().catch(() => null);
    if (!payload) return null;
    const nextJobs: DocumentJob[] = payload.jobs ?? [];
    setJobs(nextJobs);
    if (payload.estimation) setEstimationStats(payload.estimation);

    // Purge du suivi : un identifiant qui ne correspond plus à aucun job (supprimé, ou
    // sorti de la fenêtre de MAX_FILES) laisserait un panneau de progression fantôme.
    const known = new Set(nextJobs.map((job) => job.id));
    setActiveUploadJobIds((current) => {
      const kept = current.filter((id) => known.has(id));
      if (kept.length === current.length) return current;
      if (kept.length) window.localStorage.setItem(ACTIVE_UPLOAD_STORAGE_KEY, JSON.stringify(kept));
      else window.localStorage.removeItem(ACTIVE_UPLOAD_STORAGE_KEY);
      return kept;
    });
    return nextJobs;
  }, []);

  /**
   * Démarrage opportuniste des workers. Chaque invocation ne dispatche qu'un budget fixe
   * de jobs (`DIRECT_JOBS_PER_INVOCATION` en mode rapide, `BATCH_JOBS_PER_INVOCATION` en
   * mode lot — miroirs des constantes des Edge Functions) : au-delà, il faut plusieurs
   * appels, sinon le reste attend le tick de Cron suivant (1 min, partagé entre toutes
   * les organisations) — c'était le cas du mode lot, qui ne rebouclait pas : un dépôt de
   * plus de 50 documents semblait bloqué au palier des 50 premiers.
   */
  const startProcessing = useCallback((mode: "direct" | "batch", jobIds: string[]) => {
    const supabase = createClient();
    if (mode === "direct") {
      void (async () => {
        for (let index = 0; index < jobIds.length; index += DIRECT_JOBS_PER_INVOCATION) {
          await supabase.functions.invoke("process-direct-documents", {
            body: { job_ids: jobIds.slice(index, index + DIRECT_JOBS_PER_INVOCATION) },
          });
          await refreshJobs();
        }
      })().finally(() => void refreshJobs());
      return;
    }

    // Mode lot : la réservation est server-side (par organisation, pas par identifiant de
    // job), donc rien à découper en tranches côté navigateur — on relance simplement
    // l'invocation tant qu'il reste des jobs de CE dépôt encore `queued`. Garde-fou sur le
    // nombre d'appels : si jamais il est atteint, pg_cron reprend le relais normalement.
    const idSet = new Set(jobIds);
    const maxInvocations = Math.max(1, Math.ceil(jobIds.length / BATCH_JOBS_PER_INVOCATION) + 2);
    void (async () => {
      for (let attempt = 0; attempt < maxInvocations; attempt++) {
        await supabase.functions.invoke("process-document-queue", { body: {} });
        const latest = await refreshJobs();
        const stillQueued = (latest ?? []).some((job) => idSet.has(job.id) && job.status === "queued");
        if (!stillQueued) break;
      }
    })().finally(() => void refreshJobs());
  }, [refreshJobs]);

  // Progression en direct : Realtime pousse chaque transition de statut. Le sondage ne
  // sert que de filet quand le canal décroche.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    function mergeRealtimeJob(incoming: DocumentJob) {
      setJobs((current) => {
        const index = current.findIndex((job) => job.id === incoming.id);
        const next = index === -1
          ? [incoming, ...current]
          : current.map((job, jobIndex) => jobIndex === index ? { ...job, ...incoming } : job);
        return next
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          .slice(0, MAX_FILES);
      });
    }

    void (async () => {
      await refreshJobs();
      if (cancelled) return;

      channel = supabase
        .channel(`document-jobs-${orgId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "document_jobs", filter: `org_id=eq.${orgId}` },
          (payload) => {
            if (payload.eventType !== "DELETE") mergeRealtimeJob(payload.new as DocumentJob);
          },
        )
        .subscribe((status) => {
          if (cancelled) return;
          if (status === "SUBSCRIBED") setRealtimeStatus("live");
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            setRealtimeStatus("recovering");
            void refreshJobs();
          }
        });
    })();

    const fallbackTimer = window.setInterval(() => {
      const hasActiveJobs = jobsRef.current.some((job) => !isTerminalJobStatus(job.status));
      if (document.visibilityState === "visible" && hasActiveJobs) void refreshJobs();
    }, FALLBACK_REFRESH_MS);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 30_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshJobs();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(fallbackTimer);
      window.clearInterval(clockTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [orgId, refreshJobs]);

  // Dépôt externe : la facture déposée via un lien public est rapatriée dans la sélection.
  useEffect(() => {
    const pendingId = new URLSearchParams(window.location.search).get("pending");
    if (!pendingId) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/pending/${pendingId}`);
        const payload = await response.json();
        if (!response.ok || !payload.signedUrl) throw new Error(payload.error ?? "Dépôt externe introuvable.");
        const blob = await fetch(payload.signedUrl).then((result) => result.blob());
        if (!cancelled) {
          setFiles([new File([blob], payload.pending.original_name ?? "facture.pdf", { type: blob.type || "application/pdf" })]);
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Dépôt externe introuvable.");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /**
   * Inspection côté navigateur : extension, taille, et surtout **magic bytes**. Le
   * serveur revérifie tout — ici c'est pour dire tout de suite ce qui ne passera pas,
   * sans faire téléverser des centaines de fichiers pour rien.
   */
  async function addFiles(incoming: File[]) {
    if (inspecting || submitting) return;
    setInspecting(true);
    setError(null);
    const valid: File[] = [];
    const rejected: string[] = [];
    // Les bornes portent sur la sélection **complète**, pas sur le seul dépôt en cours :
    // sinon un second glisser-déposer passait les contrôles puis se faisait tronquer en
    // silence au moment de la fusion.
    const alreadySelected = files;
    let selectedCount = alreadySelected.length;
    let inspectedBytes = alreadySelected.reduce((total, file) => total + file.size, 0);

    async function inspectDocument(file: File, displayName = file.name) {
      if (selectedCount >= MAX_FILES) {
        rejected.push(`${displayName} : limite de ${MAX_FILES} documents atteinte`);
        return;
      }
      if (!file.size || file.size > MAX_FILE_SIZE) {
        rejected.push(`${displayName} : taille vide ou supérieure à 20 Mo`);
        return;
      }
      if (inspectedBytes + file.size > MAX_TOTAL_SIZE) {
        rejected.push(`${displayName} : la sélection dépasse la limite totale de 500 Mo`);
        return;
      }

      const extensionType = mimeTypeFromName(displayName);
      const detectedType = await detectDocumentType(file);
      if (!extensionType || !detectedType || extensionType !== detectedType) {
        rejected.push(`${displayName} : contenu ou extension non supporté`);
        return;
      }

      valid.push(new File([file], displayName, { type: detectedType, lastModified: file.lastModified }));
      inspectedBytes += file.size;
      selectedCount += 1;
    }

    try {
      for (const file of incoming) {
        if (!isZip(file)) {
          await inspectDocument(file, file.webkitRelativePath || file.name);
          continue;
        }

        if (!file.size || file.size > MAX_ARCHIVE_SIZE) {
          rejected.push(`${file.name} : archive vide ou supérieure à 100 Mo`);
          continue;
        }

        try {
          const JSZip = (await import("jszip")).default;
          const archive = await JSZip.loadAsync(file, { checkCRC32: true, createFolders: false });
          // Métadonnées macOS (`__MACOSX/`, `._fichier`) et fichiers cachés écartés.
          const entries = Object.values(archive.files).filter((entry) =>
            !entry.dir && !entry.name.startsWith("__MACOSX/") && !entry.name.split("/").some((part) => part.startsWith(".")),
          );

          for (const entry of entries) {
            if (selectedCount >= MAX_FILES) {
              rejected.push(`${file.name} : seuls les ${MAX_FILES} premiers documents valides sont acceptés`);
              break;
            }
            // Taille décompressée annoncée : évite de développer une bombe zip.
            const declaredSize = (entry as typeof entry & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
            if (declaredSize !== undefined && declaredSize > MAX_FILE_SIZE) {
              rejected.push(`${entry.name} : fichier décompressé supérieur à 20 Mo`);
              continue;
            }
            const content = await entry.async("uint8array");
            const contentBuffer = Uint8Array.from(content).buffer;
            await inspectDocument(new File([contentBuffer], entry.name, { lastModified: entry.date.getTime() }), entry.name);
          }
        } catch {
          rejected.push(`${file.name} : archive ZIP invalide, chiffrée ou corrompue`);
        }
      }

      setFiles((current) => {
        const merged = [...current];
        for (const file of valid) {
          if (!merged.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) {
            merged.push(file);
          }
        }
        const withinCount = merged.slice(0, MAX_FILES);
        let totalSize = 0;
        const withinLimits = withinCount.filter((file) => {
          if (totalSize + file.size > MAX_TOTAL_SIZE) return false;
          totalSize += file.size;
          return true;
        });
        if (withinLimits.length < withinCount.length) rejected.push("La sélection dépasse la limite totale de 500 Mo");
        return withinLimits;
      });

      if (rejected.length) {
        const preview = rejected.slice(0, 4).join(" ; ");
        setError(`${rejected.length} fichier${rejected.length > 1 ? "s" : ""} ignoré${rejected.length > 1 ? "s" : ""} : ${preview}${rejected.length > 4 ? "…" : ""}`);
      }
    } finally {
      setInspecting(false);
    }
  }

  /**
   * Envoi de la sélection, découpée par nombre ET par volume : le plafond de corps de
   * requête de la plateforme est atteint bien avant les 10 fichiers si les scans sont
   * lourds.
   *
   * Un envoi qui échoue ne fait plus tout perdre : les jobs déjà créés sont conservés et
   * démarrés, seuls les fichiers réellement non envoyés restent dans la sélection. Sans
   * ça, un utilisateur qui relançait après une erreur re-téléversait les lots déjà passés.
   */
  async function submit() {
    if (!files.length || submitting) return;
    setSubmitting(true);
    setUploadedCount(0);
    setError(null);
    setActiveUploadJobIds([]);
    window.localStorage.removeItem(ACTIVE_UPLOAD_STORAGE_KEY);
    // Sinon « Résultat du traitement » cumulait les compteurs du dépôt précédent avec
    // ceux du nouveau : 3 factures déposées après 5 en affichaient 8.
    setAutoResult({ autoSaved: [], toReview: [], duplicates: [] });

    const processingMode = processingModeFor(files.length);
    const submittedJobIds: string[] = [];
    const notSent: File[] = [];
    const failures: string[] = [];
    let sent = 0;

    const trackSubmitted = (ids: string[]) => {
      if (!ids.length) return;
      submittedJobIds.push(...ids);
      setActiveUploadJobIds([...submittedJobIds]);
      window.localStorage.setItem(ACTIVE_UPLOAD_STORAGE_KEY, JSON.stringify(submittedJobIds));
    };

    for (const chunk of chunkForUpload(files)) {
      try {
        const formData = new FormData();
        formData.append("processing_mode", processingMode);
        chunk.forEach((file) => formData.append("files", file));
        const response = await fetch("/api/document-jobs", { method: "POST", body: formData });
        const payload = await response.json().catch(() => ({}));

        if (!response.ok && !(payload.jobs ?? []).length) {
          failures.push(payload.error ?? `Envoi refusé (${response.status}).`);
          notSent.push(...chunk);
          continue;
        }

        trackSubmitted((payload.jobs ?? []).map((job: { id: string }) => job.id));
        // Le serveur nomme les fichiers qu'il n'a pas pu mettre en file : eux seuls
        // restent en sélection, les autres sont bien partis.
        const rejectedNames = new Set<string>(
          ((payload.errors ?? []) as Array<{ name?: string; message?: string }>).map((item) => item.name ?? ""),
        );
        for (const item of (payload.errors ?? []) as Array<{ name?: string; message?: string }>) {
          failures.push(`${item.name ?? "document"} : ${item.message ?? "mise en file impossible"}`);
        }
        notSent.push(...chunk.filter((file) => rejectedNames.has(file.name)));
        sent += chunk.length - rejectedNames.size;
        setUploadedCount(sent);
      } catch {
        failures.push("Erreur réseau pendant l'envoi.");
        notSent.push(...chunk);
      }
    }

    setFiles(notSent);
    if (failures.length) {
      const preview = failures.slice(0, 3).join(" ; ");
      setError(
        `${preview}${failures.length > 3 ? "…" : ""}`
        + (notSent.length ? ` — ${notSent.length} fichier${notSent.length > 1 ? "s restent" : " reste"} à envoyer.` : ""),
      );
    }

    await refreshJobs();
    // Démarrage immédiat opportuniste. Les Cron restent le filet de sécurité si l'onglet
    // est fermé ou si ces invocations échouent.
    if (submittedJobIds.length) startProcessing(processingMode, submittedJobIds);
    setSubmitting(false);
  }

  async function retry(jobId: string) {
    // Mode lu AVANT la relance : après `refreshJobs`, `jobsRef` n'est pas encore à jour
    // (il est réaffecté par un effet, donc après le rendu suivant).
    const mode = jobs.find((candidate) => candidate.id === jobId)?.processing_mode ?? "batch";
    const response = await fetch(`/api/document-jobs/${jobId}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "retry" }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(payload.error ?? "Nouvelle tentative impossible.");
      await refreshJobs();
      return;
    }
    // Une relance réussie remet le job en traitement : il redevient candidat à
    // l'enregistrement automatique quand son extraction reviendra.
    autoProcessedRef.current.delete(jobId);
    await refreshJobs();
    startProcessing(mode, [jobId]);
  }

  async function deleteJob(jobId: string) {
    if (!window.confirm("Supprimer ce document de la file ? L'extraction sera perdue.")) return;
    const response = await fetch(`/api/document-jobs/${jobId}`, { method: "DELETE" });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setError(payload.error ?? "Suppression impossible.");
      return;
    }
    setActiveUploadJobIds((current) => current.filter((id) => id !== jobId));
    autoProcessedRef.current.delete(jobId);
    setJobs((current) => current.filter((job) => job.id !== jobId));
    await refreshJobs();
  }

  function toggleReviewJob(jobId: string) {
    setSelectedReviewJobIds((current) => {
      const next = new Set(current);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  /** Suppression en masse, partagée entre la sélection « à réviser » et « Tout supprimer ». */
  async function deleteJobsByIds(ids: string[]) {
    const results = await Promise.all(ids.map(async (jobId) => {
      try {
        const response = await fetch(`/api/document-jobs/${jobId}`, { method: "DELETE" });
        return { jobId, deleted: response.ok };
      } catch {
        return { jobId, deleted: false };
      }
    }));
    const deletedIds = results.filter(({ deleted }) => deleted).map(({ jobId }) => jobId);
    const failedCount = results.length - deletedIds.length;

    setSelectedReviewJobIds((current) => {
      const next = new Set(current);
      deletedIds.forEach((id) => next.delete(id));
      return next;
    });
    setActiveUploadJobIds((current) => current.filter((id) => !deletedIds.includes(id)));
    deletedIds.forEach((id) => autoProcessedRef.current.delete(id));
    setJobs((current) => current.filter((job) => !deletedIds.includes(job.id)));
    if (failedCount) setError(`${failedCount} suppression${failedCount > 1 ? "s ont" : " a"} échoué. Veuillez réessayer.`);
    await refreshJobs();
  }

  async function deleteSelectedReviewJobs() {
    const ids = [...selectedReviewJobIds];
    if (!ids.length) return;
    if (!window.confirm(`Supprimer ${ids.length} facture${ids.length > 1 ? "s" : ""} à réviser ? Les extractions seront perdues.`)) return;

    setDeletingReviewJobs(true);
    setError(null);
    await deleteJobsByIds(ids);
    setDeletingReviewJobs(false);
  }

  /** « Tout supprimer » : vide la file visible (tous les jobs non terminés). */
  async function deleteAllQueueJobs() {
    const ids = jobs.filter((job) => job.status !== "completed").map((job) => job.id);
    if (!ids.length || deletingAllJobs) return;
    if (!window.confirm(`Supprimer les ${ids.length} documents de la file ? Les extractions seront perdues.`)) return;

    setDeletingAllJobs(true);
    setError(null);
    await deleteJobsByIds(ids);
    setDeletingAllJobs(false);
  }

  /** « Tout traiter quand même » : relance chaque document ignoré en forçant l'extraction. */
  async function retryAllRejected() {
    const targets = jobs.filter((job) => job.status === "rejected_non_invoice");
    if (!targets.length || retryingRejected) return;

    setRetryingRejected(true);
    setError(null);
    const results = await Promise.all(targets.map(async (job) => {
      try {
        const response = await fetch(`/api/document-jobs/${job.id}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "retry" }),
        });
        return { job, ok: response.ok };
      } catch {
        return { job, ok: false };
      }
    }));
    const relaunched = results.filter(({ ok }) => ok);
    // Un job relancé redevient candidat à l'enregistrement automatique quand son
    // extraction reviendra — même logique que la relance unitaire.
    relaunched.forEach(({ job }) => autoProcessedRef.current.delete(job.id));
    const failedCount = results.length - relaunched.length;
    if (failedCount) setError(`${failedCount} relance${failedCount > 1 ? "s ont" : " a"} échoué. Utilisez « Actualiser » puis réessayez.`);
    await refreshJobs();
    // Démarrage opportuniste groupé par mode, comme au dépôt initial.
    const directIds = relaunched.filter(({ job }) => job.processing_mode === "direct").map(({ job }) => job.id);
    const batchIds = relaunched.filter(({ job }) => job.processing_mode !== "direct").map(({ job }) => job.id);
    if (directIds.length) startProcessing("direct", directIds);
    if (batchIds.length) startProcessing("batch", batchIds);
    setRetryingRejected(false);
  }

  // File de traitement : tout ce qui n'est pas terminé. Un job `completed` = facture
  // enregistrée (ou doublon déjà en base) → il sort de la file, il reste visible dans
  // Mes documents.
  const queueJobs = jobs.filter((job) => job.status !== "completed");
  const rejectedQueueCount = queueJobs.filter((job) => job.status === "rejected_non_invoice").length;

  // Comptes par catégorie pour les puces de filtre — sur `queueJobs` en entier, pas sur
  // le résultat déjà filtré : sinon les puces des autres catégories retomberaient à zéro
  // dès qu'un filtre est actif.
  //
  // Dépendance sur `jobs` (pas `queueJobs`) : `queueJobs` est un nouveau tableau à chaque
  // rendu (`.filter` ci-dessus), il recalculerait ces `useMemo` en boucle sans rien
  // apporter — `jobs` est la vraie source stable dont `queueJobs` dérive purement.
  const queueBucketCounts = useMemo(() => {
    const counts = new Map<QueueBucket, number>();
    for (const job of queueJobs) counts.set(BUCKET_OF[job.status], (counts.get(BUCKET_OF[job.status]) ?? 0) + 1);
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs]);
  const filteredQueueJobs = useMemo(() => {
    const term = queueSearch.trim().toLowerCase();
    return queueJobs.filter((job) => {
      if (queueBucketFilter !== "all" && BUCKET_OF[job.status] !== queueBucketFilter) return false;
      if (term && !job.original_name.toLowerCase().includes(term)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, queueBucketFilter, queueSearch]);
  const filteredFiles = useMemo(() => {
    const term = fileSearch.trim().toLowerCase();
    if (!term) return files;
    return files.filter((file) => file.name.toLowerCase().includes(term));
  }, [files, fileSearch]);

  // « Tout sélectionner » du bouton de suppression groupée : porte sur les jobs
  // actuellement VISIBLES (recherche/filtre appliqués), pas sur la file entière — cocher
  // « tout » pendant qu'un filtre est actif ne doit sélectionner que ce qui est affiché.
  const visibleReviewIds = filteredQueueJobs.filter((job) => job.status === "needs_review").map((job) => job.id);
  const allVisibleReviewSelected = visibleReviewIds.length > 0 && visibleReviewIds.every((id) => selectedReviewJobIds.has(id));

  const fileVirtualizer = useVirtualizer({
    count: filteredFiles.length,
    getScrollElement: () => fileListParentRef.current,
    // Ligne à hauteur fixe (nom tronqué sur une ligne) : pas besoin de mesure dynamique.
    estimateSize: () => 44,
    overscan: 10,
    gap: 6,
  });
  const queueVirtualizer = useVirtualizer({
    count: filteredQueueJobs.length,
    getScrollElement: () => queueListParentRef.current,
    // Hauteur variable (ligne d'erreur optionnelle, boutons d'action) : mesurée réellement.
    estimateSize: () => 72,
    overscan: 8,
    gap: 8,
  });

  // Repli quand le suivi du dépôt est perdu : les jobs récents, **terminés compris**.
  // L'ancien repli ne gardait que les jobs non terminaux : chaque document qui finissait
  // quittait l'ensemble suivi, si bien que la barre restait bloquée à 0 % puis
  // disparaissait d'un coup.
  const recentJobs = jobs.filter((job) => now - new Date(job.created_at).getTime() <= RECENT_TRACKING_WINDOW_MS);

  // Suivi du dernier dépôt. Il expire tout seul : `activeUploadJobIds` n'était jamais
  // vidé — les jobs existent toujours une fois terminés, la purge de `refreshJobs` ne
  // retire que les identifiants inconnus — donc le panneau « Traitement terminé »
  // restait affiché indéfiniment, y compris après rechargement puisque la liste est
  // persistée en localStorage. L'expiration se lit sur les jobs eux-mêmes plutôt que
  // sur un minuteur du navigateur : un lot fini il y a trois heures ne réapparaît pas
  // au rechargement, un lot fini il y a une minute reste visible.
  const uploadRunJobs = activeUploadJobIds.length
    ? jobs.filter((job) => activeUploadJobIds.includes(job.id))
    : [];
  const uploadRunFinishedAt = lastActivityOf(uploadRunJobs);
  const uploadRunExpired = uploadRunJobs.length > 0
    && uploadRunJobs.every((job) => isTerminalJobStatus(job.status))
    && now - uploadRunFinishedAt >= FINISHED_PANEL_GRACE_MS;

  const trackedJobs = uploadRunJobs.length && !uploadRunExpired ? uploadRunJobs : recentJobs;
  const activeTrackedJobs = trackedJobs.filter((job) => !isTerminalJobStatus(job.status));
  const selectionMode = processingModeFor(files.length);
  const directFlow = files.length > 0
    ? selectionMode === "direct"
    : trackedJobs.length > 0 && trackedJobs.every((job) => job.processing_mode === "direct");
  const estimate = activeTrackedJobs.length
    ? estimateRemainingForJobs(activeTrackedJobs, estimationStats, now)
    : estimateForDocumentCount(files.length, estimationStats, selectionMode);
  const ocrCompleted = trackedJobs.filter((job) => ["needs_review", "completed"].includes(job.status)).length;
  const failedCount = trackedJobs.filter((job) => job.status === "failed").length;
  const rejectedCount = trackedJobs.filter((job) => job.status === "rejected_non_invoice").length;
  const trackedTotal = Math.max(trackedJobs.length, submitting ? uploadedCount : 0);
  // Progression unique : part des documents arrivés au bout (OCR terminé, échec ou ignoré).
  const progressTotal = trackedTotal || trackedJobs.length || 1;
  const doneCount = Math.min(progressTotal, ocrCompleted + failedCount + rejectedCount);
  const progressPct = Math.min(100, Math.round((doneCount / progressTotal) * 100));

  const hasAutoResult = autoResult.autoSaved.length > 0 || autoResult.toReview.length > 0 || autoResult.duplicates.length > 0;
  const lowConfidenceSaved = autoResult.autoSaved.filter((entry) => entry.lowConfidence);

  // Lot qui vient de se terminer : on garde le panneau le temps que l'utilisateur voie
  // le résultat. Au-delà, plus rien à afficher.
  const runJustFinished = trackedJobs.length > 0
    && activeTrackedJobs.length === 0
    && now - lastActivityOf(trackedJobs) < FINISHED_PANEL_GRACE_MS;
  // Le panneau ne s'affiche que s'il a quelque chose à dire : une sélection à estimer,
  // du travail en cours, ou un lot qui vient de se terminer.
  const showProgressPanel = files.length > 0 || activeTrackedJobs.length > 0 || runJustFinished;

  // Clé stable : `trackedJobs` est un nouveau tableau à chaque rendu, l'effet ci-dessous
  // se déclencherait donc en boucle. Une chaîne se compare par valeur.
  const reviewableJobKey = trackedJobs
    .filter((job) => job.status === "needs_review")
    .map((job) => job.id)
    .sort()
    .join(",");

  // Enregistrement automatique : dès qu'un document du lot passe en révision, on tente
  // l'enregistrement (extraction ET commune ≥ 96 %). Le ref évite de retraiter un job.
  useEffect(() => {
    const candidates = reviewableJobKey
      .split(",")
      .filter((id) => id && !autoProcessedRef.current.has(id));
    if (!candidates.length) return;
    candidates.forEach((id) => autoProcessedRef.current.add(id));

    void (async () => {
      let notSavedCount = 0;
      // Factures créées par les tranches déjà passées : transmises à la dernière, qui
      // seule déclenche le recalcul d'anomalies portefeuille. Sans ça, les factures des
      // tranches précédentes ne seraient jamais escaladées en `anomaly_flagged`.
      const savedInvoiceIds: string[] = [];
      // Découpé : un gros lot (jusqu'à MAX_FILES documents) dans une seule requête
      // dépasse la durée maximale de la route, et tout le travail serait perdu d'un coup.
      for (let index = 0; index < candidates.length; index += AUTO_SAVE_CHUNK) {
        const slice = candidates.slice(index, index + AUTO_SAVE_CHUNK);
        const isLastChunk = index + AUTO_SAVE_CHUNK >= candidates.length;
        try {
          const response = await fetch("/api/document-jobs/auto-save", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              job_ids: slice,
              // Le recalcul d'anomalies coûte O(taille de l'organisation) : une seule
              // fois en fin de dépôt, pas à chaque tranche.
              finalize: isLastChunk,
              ...(isLastChunk ? { escalate_invoice_ids: savedInvoiceIds } : {}),
            }),
          });
          if (!response.ok) throw new Error(String(response.status));
          const data = await response.json();
          savedInvoiceIds.push(...(data.autoSaved ?? []).map((entry: AutoSavedEntry) => entry.invoiceId));
          setAutoResult((current) => ({
            autoSaved: [...current.autoSaved, ...(data.autoSaved ?? [])],
            toReview: [...current.toReview, ...(data.toReview ?? [])],
            duplicates: [...current.duplicates, ...(data.duplicates ?? [])],
          }));
        } catch {
          // Échec réseau ou serveur : on rend les jobs à l'ensemble des candidats, sinon
          // ils restaient marqués « traités » et n'étaient plus jamais enregistrés. La
          // relance est manuelle (bouton Actualiser) pour ne pas boucler sur une panne.
          slice.forEach((id) => autoProcessedRef.current.delete(id));
          notSavedCount += slice.length;
        }
      }
      if (notSavedCount) {
        setError(`Enregistrement automatique indisponible pour ${notSavedCount} document${notSavedCount > 1 ? "s" : ""} — utilisez « Actualiser » ou révisez-les manuellement.`);
      }
      await refreshJobs();
    })();
  }, [reviewableJobKey, manualSyncCount, refreshJobs]);

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="font-heading text-2xl font-bold text-[var(--kn-text)]">Importer des factures</h1>
      <p className="mb-7 text-[13px] text-[var(--kn-text-muted)]">
        De 1 à {DIRECT_DOCUMENT_LIMIT} documents, l&apos;extraction démarre en mode rapide.
        Les lots plus grands sont traités par sous-lots, à tarif réduit, et restent
        visibles même si vous quittez cette page.
      </p>

      <div
        onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => { event.preventDefault(); setDragOver(false); void addFiles(Array.from(event.dataTransfer.files)); }}
        className={`flex min-h-44 flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed transition-colors ${dragOver ? "border-[#f97316] bg-[var(--kn-yellow-soft)]" : "border-[#c8ccd2] bg-[var(--kn-card)]"}`}
      >
        {inspecting ? <Loader2 className="size-8 animate-spin text-[#f97316]" /> : <UploadCloud className="size-8 text-[var(--kn-text-muted)]" />}
        <div className="text-center">
          <p className="text-sm font-medium text-[var(--kn-text)]">
            {inspecting ? "Vérification des fichiers…" : "Glissez vos factures ou une archive ZIP ici"}
          </p>
          <p className="text-xs text-[var(--kn-text-muted)]">PDF, PNG, JPEG, WEBP ou ZIP · 20 Mo maximum par document</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <button type="button" disabled={inspecting || submitting} onClick={() => inputRef.current?.click()} className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-3 py-2 text-xs font-semibold text-[var(--kn-text)] transition-colors hover:border-[#f97316] hover:bg-[var(--kn-active)] disabled:cursor-not-allowed disabled:opacity-50">
            <Archive className="size-4" />Fichiers ou ZIP
          </button>
          <button type="button" disabled={inspecting || submitting} onClick={() => folderInputRef.current?.click()} className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-3 py-2 text-xs font-semibold text-[var(--kn-text)] transition-colors hover:border-[#f97316] hover:bg-[var(--kn-active)] disabled:cursor-not-allowed disabled:opacity-50">
            <FolderOpen className="size-4" />Choisir un dossier
          </button>
        </div>
      </div>
      <input ref={inputRef} type="file" multiple accept="application/pdf,image/png,image/jpeg,image/webp,.zip,application/zip" className="hidden"
        onChange={(event) => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      <input ref={folderInputRef} type="file" multiple className="hidden"
        onChange={(event) => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />

      {files.length > 0 && (
        <div className="mt-4 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-[var(--kn-text)]">
              {fmt(files.length)} fichier{files.length > 1 ? "s" : ""} prêt{files.length > 1 ? "s" : ""}
              <span className="ml-2 font-normal text-[var(--kn-text-muted)]">
                — mode {selectionMode === "direct" ? "rapide" : "lot (tarif réduit)"}
              </span>
            </p>
            <button onClick={() => { setFiles([]); setFileSearch(""); }} className="cursor-pointer text-xs text-[var(--kn-text-muted)] hover:text-[var(--kn-text)]">Tout retirer</button>
          </div>

          {files.length > LARGE_LIST_THRESHOLD && (
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--kn-text-muted)]" />
              <input
                type="text"
                value={fileSearch}
                onChange={(event) => setFileSearch(event.target.value)}
                placeholder={`Rechercher parmi ${fmt(files.length)} fichiers…`}
                className="w-full rounded-lg border border-[var(--kn-border)] bg-[var(--kn-panel)] py-1.5 pl-8 pr-2.5 text-xs text-[var(--kn-text)] outline-none focus:border-[#f97316]"
              />
            </div>
          )}

          {filteredFiles.length === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-[var(--kn-text-muted)]">Aucun fichier ne correspond à « {fileSearch} ».</p>
          ) : (
            <div ref={fileListParentRef} className="max-h-72 overflow-y-auto" style={{ contain: "strict" }}>
              <div style={{ height: fileVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
                {fileVirtualizer.getVirtualItems().map((virtualRow) => {
                  const file = filteredFiles[virtualRow.index];
                  return (
                    <div
                      key={virtualRow.key}
                      data-index={virtualRow.index}
                      ref={fileVirtualizer.measureElement}
                      style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}
                    >
                      <div className="flex h-[38px] items-center gap-2 rounded-lg bg-[var(--kn-panel)] px-3 text-sm">
                        <FileText className="size-4 shrink-0 text-[#f97316]" />
                        <span className="min-w-0 flex-1 truncate">{file.name}</span>
                        <span className="shrink-0 text-xs text-[var(--kn-text-muted)]">{(file.size / 1024 / 1024).toFixed(1)} Mo</span>
                        <button
                          aria-label={`Retirer ${file.name}`}
                          onClick={() => setFiles((current) => current.filter((item) => !sameFile(item, file)))}
                          className="shrink-0 cursor-pointer rounded p-0.5 text-[var(--kn-text-muted)] hover:text-[var(--kn-text)]"
                        >
                          <X className="size-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <button disabled={submitting} onClick={submit} className="mt-3 flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-[#f97316] px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60">
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <UploadCloud className="size-4" />}
            {submitting ? `Envoi… ${fmt(uploadedCount)}/${fmt(files.length)}` : `Ajouter ${fmt(files.length)} fichier${files.length > 1 ? "s" : ""} à la file d’attente`}
          </button>
        </div>
      )}

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />{error}
        </div>
      )}

      {showProgressPanel && (
        <div className="mt-4 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-[var(--kn-text)]">
                {activeTrackedJobs.length ? "Traitement en cours" : trackedJobs.length ? "Traitement terminé" : "Estimation avant envoi"}
              </p>
              {estimate && (activeTrackedJobs.length > 0 || files.length > 0) && (
                <p className="mt-0.5 text-lg font-bold text-[#f97316]">
                  Environ {estimate.minimumMinutes}–{estimate.maximumMinutes} min
                  {activeTrackedJobs.length > 0 ? " restantes" : ""}
                </p>
              )}
              {!directFlow && (
                <p className="mt-1 text-xs text-[var(--kn-text-muted)]">
                  {estimationStats?.source === "historical"
                    ? `Estimation basée sur ${estimationStats.sampleCount} lots terminés récemment.`
                    : "Estimation prudente initiale, recalibrée automatiquement après 5 lots terminés."}
                </p>
              )}
            </div>
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${realtimeStatus === "live" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
              {realtimeStatus === "live" ? "Suivi en direct" : realtimeStatus === "connecting" ? "Connexion au suivi…" : "Reconnexion au suivi…"}
            </span>
          </div>

          {trackedJobs.length > 0 && (
            <div className="mt-4">
              <div className="mb-1.5 flex items-center justify-end text-xs">
                <span className="font-semibold tabular-nums text-[var(--kn-text)]">{fmt(doneCount)}/{fmt(progressTotal)} · {progressPct} %</span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-[var(--kn-panel)]">
                <div className="h-full rounded-full bg-[#f97316] transition-[width] duration-500" style={{ width: `${progressPct}%` }} />
              </div>
              {failedCount > 0 && <p className="mt-2 text-xs font-medium text-red-600">{failedCount} document{failedCount > 1 ? "s" : ""} en échec — vous pouvez les relancer individuellement.</p>}
              {rejectedCount > 0 && <p className="mt-2 text-xs font-medium text-amber-700">{rejectedCount} document{rejectedCount > 1 ? "s" : ""} ignoré{rejectedCount > 1 ? "s" : ""} (pas reconnu{rejectedCount > 1 ? "s" : ""} comme facture) — vérifiez et forcez le traitement si besoin.</p>}
            </div>
          )}
        </div>
      )}

      {hasAutoResult && (
        <div className="mt-4 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-4">
          <p className="text-sm font-semibold text-[var(--kn-text)]">Résultat du traitement</p>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5 text-[13px]">
            <span className="inline-flex items-center gap-1.5 text-emerald-700">
              <CheckCircle2 className="size-4" /> {fmt(autoResult.autoSaved.length)} enregistrée{autoResult.autoSaved.length > 1 ? "s" : ""} auto
              {lowConfidenceSaved.length > 0 && <span className="font-normal text-[var(--kn-text-muted)]"> (dont {fmt(lowConfidenceSaved.length)} à vérifier)</span>}
            </span>
            <span className="inline-flex items-center gap-1.5 text-amber-700"><Clock3 className="size-4" /> {fmt(autoResult.toReview.length)} à réviser</span>
            <span className="inline-flex items-center gap-1.5 text-[var(--kn-text-muted)]"><FileText className="size-4" /> {fmt(autoResult.duplicates.length)} déjà en base</span>
          </div>

          {autoResult.autoSaved.length > 0 && (
            <p className="mt-2 text-xs text-[var(--kn-text-muted)]">
              Les factures enregistrées automatiquement arrivent « à contrôler » dans Mes documents.
            </p>
          )}

          {lowConfidenceSaved.length > 0 && (
            <div className="mt-3">
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-red-700">Enregistrées à confiance réduite — à vérifier en priorité</p>
              <div className="space-y-1">
                {lowConfidenceSaved.map((entry) => (
                  <Link key={entry.jobId} href={`/documents/extraction?id=${entry.invoiceId}`} className="flex items-center justify-between rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700 hover:bg-red-100">
                    <span className="truncate">Facture {entry.factureNumber} — commune ou extraction incertaine</span>
                    <span className="inline-flex shrink-0 items-center gap-1 font-medium">Voir <ExternalLink className="size-3.5" /></span>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {autoResult.duplicates.length > 0 && (
            <div className="mt-3">
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">Déjà dans Mes documents</p>
              <div className="space-y-1">
                {autoResult.duplicates.map((duplicate) => (
                  <Link key={duplicate.jobId} href={`/documents/extraction?id=${duplicate.existingInvoiceId}`} className="flex items-center justify-between rounded-lg bg-[var(--kn-panel)] px-3 py-2 text-[13px] hover:bg-[var(--kn-active)]">
                    <span className="truncate">Facture {duplicate.factureNumber} — déjà enregistrée</span>
                    <span className="inline-flex shrink-0 items-center gap-1 font-medium text-[#f97316]">Voir <ExternalLink className="size-3.5" /></span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-[var(--kn-text)]">
            File de traitement
            {queueJobs.length > 0 && <span className="ml-1.5 font-normal text-[var(--kn-text-muted)]">({fmt(queueJobs.length)})</span>}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {visibleReviewIds.length > 0 && (
              <button
                type="button"
                onClick={() => setSelectedReviewJobIds((current) => {
                  const next = new Set(current);
                  if (allVisibleReviewSelected) visibleReviewIds.forEach((id) => next.delete(id));
                  else visibleReviewIds.forEach((id) => next.add(id));
                  return next;
                })}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--kn-border)] px-3 py-1.5 text-xs font-semibold text-[var(--kn-text)] transition-colors hover:bg-[var(--kn-active)]"
              >
                {allVisibleReviewSelected ? <CheckSquare className="size-3.5" /> : <Square className="size-3.5" />}
                Tout sélectionner ({fmt(visibleReviewIds.length)})
              </button>
            )}
            {rejectedQueueCount > 1 && (
              <button
                type="button"
                disabled={retryingRejected || submitting}
                onClick={() => void retryAllRejected()}
                title="Relance tous les documents ignorés en forçant l'extraction complète."
                className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--kn-border)] px-3 py-1.5 text-xs font-semibold text-[var(--kn-text)] transition-colors hover:border-[#f97316] hover:bg-[var(--kn-active)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {retryingRejected ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                Tout traiter quand même ({fmt(rejectedQueueCount)})
              </button>
            )}
            {queueJobs.length > 1 && (
              <button
                type="button"
                disabled={deletingAllJobs || retryingRejected}
                onClick={() => void deleteAllQueueJobs()}
                title="Supprime tous les documents de la file. Les extractions seront perdues."
                className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deletingAllJobs ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                Tout supprimer
              </button>
            )}
            {selectedReviewJobIds.size > 0 && (
              <button
                type="button"
                disabled={deletingReviewJobs}
                onClick={() => void deleteSelectedReviewJobs()}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deletingReviewJobs ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                Supprimer ({fmt(selectedReviewJobIds.size)})
              </button>
            )}
            <button onClick={() => { setError(null); setManualSyncCount((count) => count + 1); void refreshJobs(); }} className="flex cursor-pointer items-center gap-1 text-xs text-[var(--kn-text-muted)] hover:text-[var(--kn-text)]">
              <RefreshCw className="size-3.5" />Actualiser
            </button>
          </div>
        </div>

        {queueJobs.length > LARGE_LIST_THRESHOLD && (
          <div className="mb-3 space-y-2">
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setQueueBucketFilter("all")}
                className={`cursor-pointer rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${queueBucketFilter === "all" ? "bg-[#f97316] text-white" : "bg-[var(--kn-panel)] text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)]"}`}
              >
                Tous ({fmt(queueJobs.length)})
              </button>
              {BUCKET_ORDER.filter((bucket) => (queueBucketCounts.get(bucket) ?? 0) > 0).map((bucket) => (
                <button
                  key={bucket}
                  type="button"
                  onClick={() => setQueueBucketFilter((current) => current === bucket ? "all" : bucket)}
                  className={`cursor-pointer rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${queueBucketFilter === bucket ? "bg-[#f97316] text-white" : "bg-[var(--kn-panel)] text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)]"}`}
                >
                  {BUCKET_LABEL[bucket]} ({fmt(queueBucketCounts.get(bucket) ?? 0)})
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--kn-text-muted)]" />
              <input
                type="text"
                value={queueSearch}
                onChange={(event) => setQueueSearch(event.target.value)}
                placeholder="Rechercher un document…"
                className="w-full rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] py-1.5 pl-8 pr-2.5 text-xs text-[var(--kn-text)] outline-none focus:border-[#f97316]"
              />
            </div>
          </div>
        )}

        {!queueJobs.length ? (
          <div className="rounded-xl border border-dashed border-[var(--kn-border)] px-4 py-8 text-center text-sm text-[var(--kn-text-muted)]">
            Aucun document dans la file.
          </div>
        ) : !filteredQueueJobs.length ? (
          <div className="rounded-xl border border-dashed border-[var(--kn-border)] px-4 py-8 text-center text-sm text-[var(--kn-text-muted)]">
            Aucun document ne correspond à ce filtre.
            <button type="button" onClick={() => { setQueueBucketFilter("all"); setQueueSearch(""); }} className="ml-1 cursor-pointer font-semibold text-[#f97316] hover:underline">Réinitialiser</button>
          </div>
        ) : (
          <div ref={queueListParentRef} className="max-h-[36rem] overflow-y-auto" style={{ contain: "strict" }}>
            <div style={{ height: queueVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
              {queueVirtualizer.getVirtualItems().map((virtualRow) => {
                const job = filteredQueueJobs[virtualRow.index];
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={queueVirtualizer.measureElement}
                    style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <div className="flex items-center gap-3 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] px-4 py-3">
                      {["direct_processing", "uploading_to_claude", "batched", "processing"].includes(job.status) ? <Loader2 className="size-5 shrink-0 animate-spin text-[#f97316]" />
                        : job.status === "needs_review" ? <CheckCircle2 className="size-5 shrink-0 text-emerald-600" />
                        : job.status === "failed" ? <AlertCircle className="size-5 shrink-0 text-red-600" />
                        : job.status === "rejected_non_invoice" ? <AlertCircle className="size-5 shrink-0 text-amber-600" /> : <Clock3 className="size-5 shrink-0 text-amber-600" />}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-[var(--kn-text)]">{job.original_name}</p>
                        <p className="text-xs text-[var(--kn-text-muted)]">
                          {statusLabel[job.status] ?? job.status}{job.attempt_count ? ` · tentative ${job.attempt_count}` : ""}
                          {job.status === "rejected_non_invoice" && job.prefilter_type ? ` · détecté comme ${prefilterTypeLabel[job.prefilter_type] ?? job.prefilter_type}` : ""}
                        </p>
                        {job.last_error && <p className="mt-1 line-clamp-2 text-xs text-red-600">{job.last_error}</p>}
                      </div>
                      {job.status === "needs_review" && (
                        <button onClick={() => router.push(`/upload/review?job=${job.id}`)} className="shrink-0 cursor-pointer rounded-lg bg-[#f97316] px-3 py-1.5 text-xs font-semibold text-white">Réviser</button>
                      )}
                      {job.status === "failed" && (
                        <button onClick={() => void retry(job.id)} className="shrink-0 cursor-pointer rounded-lg border border-[var(--kn-border)] px-3 py-1.5 text-xs font-semibold"><RefreshCw className="mr-1 inline size-3" />Réessayer</button>
                      )}
                      {job.status === "rejected_non_invoice" && (
                        <button onClick={() => void retry(job.id)} title="Le document a été jugé non-facture par erreur : relancez pour forcer l'extraction complète." className="shrink-0 cursor-pointer rounded-lg border border-[var(--kn-border)] px-3 py-1.5 text-xs font-semibold"><RefreshCw className="mr-1 inline size-3" />Traiter quand même</button>
                      )}
                      {job.status === "needs_review" ? (
                        <button
                          type="button"
                          onClick={() => toggleReviewJob(job.id)}
                          aria-pressed={selectedReviewJobIds.has(job.id)}
                          title={selectedReviewJobIds.has(job.id) ? "Retirer de la sélection" : "Sélectionner pour suppression"}
                          aria-label={selectedReviewJobIds.has(job.id) ? `Retirer ${job.original_name} de la sélection` : `Sélectionner ${job.original_name} pour suppression`}
                          className={`shrink-0 cursor-pointer rounded-lg p-1.5 transition-colors ${selectedReviewJobIds.has(job.id) ? "bg-red-600 text-white" : "text-[var(--kn-text-muted)] hover:bg-[#fef2f2] hover:text-[#b91c1c]"}`}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      ) : (
                        <button onClick={() => void deleteJob(job.id)} title="Supprimer de la file" aria-label="Supprimer de la file" className="shrink-0 cursor-pointer rounded-lg p-1.5 text-[var(--kn-text-muted)] transition-colors hover:bg-[#fef2f2] hover:text-[#b91c1c]"><Trash2 className="size-4" /></button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
