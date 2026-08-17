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
  BATCH_JOBS_PER_INVOCATION, DIRECT_JOBS_PER_INVOCATION,
  MAX_ARCHIVE_SIZE, MAX_FILES, MAX_FILE_SIZE, MAX_TOTAL_SIZE, STATUS_PROGRESS, UPLOAD_DEBOUNCE_MS,
  buildQueueStoragePath, chunkForUpload, detectDocumentType, extensionOf, mimeTypeFromName, processingModeFor,
} from "@/lib/documents/queue";
import {
  estimateForDocumentCount, estimateRemainingForJobs, type ProcessingEstimateStats,
} from "@/lib/documents/processing-estimate";
import { MULTI_INVOICE_PAGE_THRESHOLD, type DetectedInvoice } from "@/lib/anthropic/invoice-splitting";
import { countPdfPages, splitPdfByRanges } from "@/lib/documents/pdf-split";
import { SplitConfirmation, type SplitCandidate } from "@/components/upload/split-confirmation";
import { LocalFileThumb } from "@/components/upload/local-file-thumb";
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

/** Parallélise un travail par fichier sans dépasser `limit` en vol — même forme que
 * côté Edge Functions/route serveur (`mapWithConcurrency`), gardée locale ici plutôt
 * que partagée : la version navigateur n'a rien de spécifique à mutualiser. */
async function mapWithConcurrency<T, R>(values: T[], limit: number, worker: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await worker(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => run()));
  return results;
}
/** Envois directs navigateur → Storage en vol simultanément. */
const UPLOAD_CONCURRENCY = 6;

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
/**
 * Étapes du parcours d'un document, dans l'ordre où il les traverse. Sert la barre de
 * progression segmentée : une seule barre en pourcentage ne disait pas OÙ en était le
 * lot — 40 % pouvait aussi bien signifier « tout est encore en file d'attente » que
 * « la moitié attend une révision humaine », deux situations qui n'appellent pas du
 * tout la même action.
 */
type PipelineStage = "waiting" | "preparing" | "extracting" | "review" | "saved" | "issue";
const STAGE_OF: Record<DocumentJobStatus, PipelineStage> = {
  queued: "waiting",
  direct_queued: "waiting",
  uploading_to_claude: "preparing",
  direct_processing: "extracting",
  batched: "extracting",
  processing: "extracting",
  needs_review: "review",
  completed: "saved",
  failed: "issue",
  rejected_non_invoice: "issue",
};
/** Ordre d'affichage de la barre + libellés. `issue` en dernier : c'est une sortie de route. */
const PIPELINE_STAGES: Array<{ key: PipelineStage; label: string; className: string; dotClassName: string }> = [
  { key: "waiting", label: "En attente", className: "bg-[#cbd5e1]", dotClassName: "bg-[#94a3b8]" },
  { key: "preparing", label: "Préparation", className: "bg-[#fdba74]", dotClassName: "bg-[#fb923c]" },
  { key: "extracting", label: "Extraction", className: "bg-[#f97316]", dotClassName: "bg-[#f97316]" },
  { key: "review", label: "À réviser", className: "bg-[#fbbf24]", dotClassName: "bg-[#f59e0b]" },
  { key: "saved", label: "Enregistrées", className: "bg-emerald-500", dotClassName: "bg-emerald-500" },
  { key: "issue", label: "À traiter", className: "bg-red-400", dotClassName: "bg-red-500" },
];

/** Teintes des badges de statut par étape — texte foncé sur fond clair (contraste ≥ 4,5:1). */
const STAGE_BADGE_CLASS: Record<PipelineStage, string> = {
  waiting: "bg-slate-100 text-slate-700",
  preparing: "bg-orange-100 text-orange-800",
  extracting: "bg-orange-100 text-orange-800",
  review: "bg-amber-100 text-amber-800",
  saved: "bg-emerald-100 text-emerald-800",
  issue: "bg-red-100 text-red-700",
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

export function DocumentQueue({ orgId, userId }: { orgId: string; userId: string }) {
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
  /**
   * Scan multi-factures en attente de validation. Tant qu'il est posé, rien n'est mis
   * en file : l'utilisateur doit d'abord confirmer le découpage.
   */
  const [splitCandidate, setSplitCandidate] = useState<(SplitCandidate & { tempPath: string }) | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  /**
   * Documents écartés avant import parce qu'ils ne contiennent pas de factures
   * (bordereaux récapitulatifs, courriers). Signalés discrètement plutôt que mis en
   * file : ils n'ont rien à y faire, et les y laisser reviendrait à payer leur
   * extraction pour finir par les marquer « ignorés ».
   */
  const [skipped, setSkipped] = useState<Array<{ name: string; kind: string }>>([]);
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
   * Envoi de la sélection, en deux temps.
   *
   * 1. Chaque fichier est déposé DIRECTEMENT du navigateur vers le bucket Supabase
   *    Storage (policy RLS `org_upload_invoice_files`) — les octets ne passent plus
   *    par notre route. Une Vercel Function a un plafond de corps de requête entrant
   *    fixe et non configurable (4,5 Mo, `FUNCTION_PAYLOAD_TOO_LARGE`) : un seul PDF
   *    au-delà — bien en dessous de `MAX_FILE_SIZE` — le déclenchait, quel que soit le
   *    découpage par lot côté serveur.
   * 2. Une fois déposés, leurs métadonnées (chemins, pas de contenu) sont envoyées par
   *    lots JSON à `/api/document-jobs`, qui retélécharge chaque fichier pour revalider
   *    les magic bytes avant de créer sa ligne `document_jobs`.
   *
   * Un envoi qui échoue ne fait plus tout perdre : les jobs déjà créés sont conservés et
   * démarrés, seuls les fichiers réellement non envoyés restent dans la sélection. Sans
   * ça, un utilisateur qui relançait après une erreur re-téléversait les lots déjà passés.
   */
  /**
   * Cherche dans la sélection le premier PDF assez épais pour contenir plusieurs
   * factures, et le fait analyser.
   *
   * Le fichier est déposé dans le bucket avant l'analyse : la route lit depuis le
   * stockage plutôt que de recevoir le PDF (jusqu'à 11,5 Mo, très au-delà du plafond
   * de corps de requête d'une Vercel Function). Le dépôt est temporaire — il est retiré
   * après découpage comme après annulation.
   *
   * Renvoie `true` si un candidat attend une validation : l'appelant s'arrête là.
   */
  async function detectSplitCandidate(): Promise<boolean> {
    const supabase = createClient();
    for (const file of files) {
      if (file.type !== "application/pdf") continue;
      const pageCount = await countPdfPages(file).catch(() => 0);
      if (pageCount < MULTI_INVOICE_PAGE_THRESHOLD) continue;

      setAnalyzing(true);
      const tempPath = buildQueueStoragePath(orgId, userId, `split-${crypto.randomUUID()}`, file.name);
      try {
        const { error: uploadError } = await supabase.storage.from("invoice-files")
          .upload(tempPath, file, { contentType: file.type, upsert: false });
        if (uploadError) throw new Error(uploadError.message);

        const response = await fetch("/api/documents/detect-invoices", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ file_path: tempPath }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error ?? "Analyse impossible.");

        // Bordereau ou document hors sujet : il ne CONTIENT pas de factures, il les
        // récapitule. On l'écarte ici, avant toute mise en file — sans quoi on paierait
        // son extraction complète pour finir par le marquer « ignoré ».
        if (payload.kind && payload.kind !== "factures") {
          await supabase.storage.from("invoice-files").remove([tempPath]).catch(() => {});
          setFiles((current) => current.filter((item) => item !== file));
          setSkipped((current) => [...current, { name: file.name, kind: payload.kind as string }]);
          continue;
        }

        const invoices = (payload.invoices ?? []) as DetectedInvoice[];
        // Une seule facture détectée : le document est une facture normale qui tient sur
        // plusieurs pages. Rien à découper, rien à demander à l'utilisateur.
        if (invoices.length <= 1) {
          await supabase.storage.from("invoice-files").remove([tempPath]);
          continue;
        }

        setSplitCandidate({ file, pageCount: payload.page_count ?? pageCount, invoices, tempPath });
        return true;
      } catch (reason) {
        await supabase.storage.from("invoice-files").remove([tempPath]).catch(() => {});
        setError(
          `${file.name} : ${reason instanceof Error ? reason.message : "analyse impossible"} — le document sera importé tel quel.`,
        );
        // Analyse en échec : on ne bloque pas l'import, le document part par le chemin
        // normal. Il ressortira « ignoré » s'il s'agit bien d'un scan multi-factures.
        continue;
      } finally {
        setAnalyzing(false);
      }
    }
    return false;
  }

  /**
   * Démarrage automatique de l'import, une fois le dépôt stabilisé.
   *
   * Remplace le bouton « ajouter à la file » : déposer des fichiers EST l'intention,
   * la confirmation ne protégeait de rien (une erreur se corrige en supprimant la ligne
   * dans la liste). Le délai regroupe les glissers successifs en un seul lot — c'est
   * lui qui permet au tarif réduit de s'appliquer, un lot morcelé coûtant le double.
   */
  useEffect(() => {
    if (!files.length || submitting || analyzing || splitCandidate) return;
    const timer = window.setTimeout(() => { void submit(); }, UPLOAD_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // `submit` est recréé à chaque rendu : le référencer relancerait le minuteur en
    // boucle. Les états qui doivent vraiment réarmer l'attente sont listés ici.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, submitting, analyzing, splitCandidate]);

  /** Découpe le candidat validé et remplace le scan d'origine par ses morceaux. */
  async function confirmSplit(accepted: DetectedInvoice[]) {
    if (!splitCandidate) return;
    setSubmitting(true);
    try {
      const parts = await splitPdfByRanges(splitCandidate.file, accepted);
      const supabase = createClient();
      await supabase.storage.from("invoice-files").remove([splitCandidate.tempPath]).catch(() => {});
      setFiles((current) => current.flatMap((file) => file === splitCandidate.file ? parts : [file]));
      setSplitCandidate(null);
    } catch {
      setError("Découpage impossible — réessayez ou scindez le PDF avant l'import.");
    } finally {
      setSubmitting(false);
    }
  }

  /** Abandon du découpage : le scan est retiré de la sélection, les autres restent. */
  async function cancelSplit() {
    if (!splitCandidate) return;
    const supabase = createClient();
    await supabase.storage.from("invoice-files").remove([splitCandidate.tempPath]).catch(() => {});
    setFiles((current) => current.filter((file) => file !== splitCandidate.file));
    setSplitCandidate(null);
    setError(`${splitCandidate.file.name} retiré de la sélection — découpez-le avant de le réimporter.`);
  }

  async function submit() {
    if (!files.length || submitting || analyzing) return;

    // Point d'arrêt : un scan multi-factures doit être validé avant toute mise en file.
    // Sans ça, le pipeline en extrait UNE facture et perd les autres en silence — la
    // panne qui a produit 14 factures erronées en production.
    if (await detectSplitCandidate()) return;

    setSubmitting(true);
    setUploadedCount(0);
    setError(null);
    setActiveUploadJobIds([]);
    window.localStorage.removeItem(ACTIVE_UPLOAD_STORAGE_KEY);
    // Sinon « Résultat du traitement » cumulait les compteurs du dépôt précédent avec
    // ceux du nouveau : 3 factures déposées après 5 en affichaient 8.
    setAutoResult({ autoSaved: [], toReview: [], duplicates: [] });

    const processingMode = processingModeFor(files.length);
    const supabase = createClient();
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

    // 1. Dépôt direct vers Storage, en parallèle borné.
    type UploadedMeta = { id: string; file_path: string; original_name: string; mime_type: string; file_size: number };
    const byId = new Map<string, File>();
    const uploaded: UploadedMeta[] = [];

    await mapWithConcurrency(files, UPLOAD_CONCURRENCY, async (file) => {
      const jobId = crypto.randomUUID();
      byId.set(jobId, file);
      const filePath = buildQueueStoragePath(orgId, userId, jobId, file.name);
      const { error: uploadError } = await supabase.storage.from("invoice-files").upload(
        filePath, file, { contentType: file.type, upsert: false },
      );
      if (uploadError) {
        failures.push(`${file.name} : ${uploadError.message}`);
        notSent.push(file);
        return;
      }
      uploaded.push({ id: jobId, file_path: filePath, original_name: file.name, mime_type: file.type, file_size: file.size });
      sent += 1;
      setUploadedCount(sent);
    });

    // 2. Création des jobs par lots de métadonnées — JSON léger, plus de contrainte de
    // poids ici, seulement de nombre (chaque entrée fait retélécharger son fichier
    // côté serveur pour la revalidation).
    for (const chunk of chunkForUpload(uploaded)) {
      const chunkFiles = chunk.map((meta) => byId.get(meta.id)!).filter(Boolean);
      try {
        const response = await fetch("/api/document-jobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ processing_mode: processingMode, files: chunk }),
        });
        const payload = await response.json().catch(() => ({}));

        if (!response.ok && !(payload.jobs ?? []).length) {
          failures.push(payload.error ?? `Envoi refusé (${response.status}).`);
          notSent.push(...chunkFiles);
          continue;
        }

        trackSubmitted((payload.jobs ?? []).map((job: { id: string }) => job.id));
        // Le serveur identifie les fichiers qu'il n'a pas pu mettre en file par leur
        // id (celui-là même utilisé pour le chemin de dépôt) : eux seuls restent en
        // sélection, les autres sont bien partis.
        const rejectedIds = new Set<string>(
          ((payload.errors ?? []) as Array<{ id?: string; name?: string; message?: string }>).map((item) => item.id ?? ""),
        );
        for (const item of (payload.errors ?? []) as Array<{ name?: string; message?: string }>) {
          failures.push(`${item.name ?? "document"} : ${item.message ?? "mise en file impossible"}`);
        }
        for (const meta of chunk) {
          if (rejectedIds.has(meta.id)) {
            const file = byId.get(meta.id);
            if (file) notSent.push(file);
          }
        }
      } catch {
        failures.push("Erreur réseau pendant l'envoi.");
        notSent.push(...chunkFiles);
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
  /**
   * File affichée : ni les documents terminés, ni ceux écartés comme non-factures.
   *
   * Les `rejected_non_invoice` restent en base (traçabilité, et le bouton « Traiter
   * quand même » doit rester possible via la puce de filtre), mais ils encombraient la
   * liste principale d'entrées sur lesquelles l'utilisateur n'a rien à faire. Ils
   * restent atteignables par le filtre « Ignorés ».
   */
  const queueJobs = jobs.filter((job) =>
    job.status !== "completed"
    && (queueBucketFilter === "rejected" || job.status !== "rejected_non_invoice"),
  );

  /**
   * Documents en attente de révision, sur TOUTE la file — pas seulement sur le dépôt
   * suivi (`trackedJobs`, borné à 2 h). Après un rechargement de page ou le lendemain,
   * l'appel à l'action doit rester visible tant qu'il reste du travail : c'est
   * précisément là que l'utilisateur risque d'oublier des factures en attente.
   */
  const pendingReviewJobs = jobs
    .filter((job) => job.status === "needs_review")
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
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
    // Compté sur TOUS les documents non terminés, pas sur la liste affichée : les
    // `rejected_non_invoice` sont masqués de la liste principale, mais leur puce doit
    // rester visible et cliquable — sinon ils deviendraient inatteignables.
    for (const job of jobs) {
      if (job.status === "completed") continue;
      counts.set(BUCKET_OF[job.status], (counts.get(BUCKET_OF[job.status]) ?? 0) + 1);
    }
    return counts;
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
    // Hauteur de ligne avec vignette (52 px) + l'espacement `gap` ci-dessous.
    estimateSize: () => 58,
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
  const progressTotal = trackedTotal || trackedJobs.length || 1;
  const doneCount = Math.min(progressTotal, ocrCompleted + failedCount + rejectedCount);
  /**
   * Progression pondérée par étape plutôt que par document terminé.
   *
   * L'ancien calcul comptait un document 0 ou 1 : sur un lot en extraction, la barre
   * restait à 0 % pendant plusieurs minutes alors que le travail avançait — exactement
   * le reproche fait à cet écran. Chaque document contribue désormais à hauteur de
   * l'étape qu'il a atteinte (`STATUS_PROGRESS`).
   */
  const progressPct = trackedJobs.length
    ? Math.min(100, Math.round(
        (trackedJobs.reduce((total, job) => total + (STATUS_PROGRESS[job.status] ?? 0), 0)
          / Math.max(trackedJobs.length, progressTotal)) * 100,
      ))
    : 0;

  // Répartition du lot suivi par étape du parcours — alimente la barre segmentée.
  const stageCounts = useMemo(() => {
    const counts = new Map<PipelineStage, number>();
    for (const job of trackedJobs) counts.set(STAGE_OF[job.status], (counts.get(STAGE_OF[job.status]) ?? 0) + 1);
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, activeUploadJobIds, now]);
  const visibleStages = PIPELINE_STAGES.filter((stage) => (stageCounts.get(stage.key) ?? 0) > 0);
  const reviewPendingCount = stageCounts.get("review") ?? 0;
  /** Premier document à réviser du lot, dans l'ordre de dépôt — cible du bouton d'action. */
  const firstReviewJobId = trackedJobs
    .filter((job) => job.status === "needs_review")
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())[0]?.id ?? null;

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
        Déposez vos factures : l&apos;import démarre tout seul. Vous pouvez fermer cette
        page, le traitement continue.
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

          {/* `contain` volontairement sans `size` (que `strict` inclut) : un conteneur
              qui ignore son contenu pour se dimensionner retombe à 0 px dès lors que
              seule une hauteur MAX est fixée — la liste devenait alors invisible tout
              en annonçant son nombre d'éléments. */}
          {filteredFiles.length === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-[var(--kn-text-muted)]">Aucun fichier ne correspond à « {fileSearch} ».</p>
          ) : (
            <div ref={fileListParentRef} className="max-h-72 overflow-y-auto" style={{ contain: "layout paint style" }}>
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
                      <div className="flex h-[52px] items-center gap-2.5 rounded-lg bg-[var(--kn-panel)] px-2.5 text-sm">
                        {/* Aperçu réel plutôt qu'une icône générique : c'est ce qui permet
                            de vérifier qu'on a déposé les bons documents. */}
                        <LocalFileThumb file={file} className="size-10" />
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

          {/* Plus de bouton d'envoi : l'import part tout seul une fois le dépôt stabilisé.
              Cette bande dit ce qui se passe et laisse le temps de se raviser. */}
          <div className="mt-3 flex items-center justify-center gap-2 rounded-lg bg-[var(--kn-panel)] px-4 py-2.5 text-sm font-medium text-[var(--kn-text)]">
            <Loader2 className="size-4 animate-spin text-[#f97316]" />
            {analyzing
              ? "Analyse d’un document de plusieurs pages…"
              : submitting
                ? `Envoi en cours… ${fmt(uploadedCount)}/${fmt(files.length)}`
                : `Import automatique de ${fmt(files.length)} facture${files.length > 1 ? "s" : ""}…`}
          </div>
        </div>
      )}

      {/* `key` : un nouveau candidat doit repartir d'un état vierge (vignettes, exclusions). */}
      {splitCandidate && (
        <SplitConfirmation
          key={splitCandidate.tempPath}
          candidate={splitCandidate}
          submitting={submitting}
          onConfirm={(accepted) => void confirmSplit(accepted)}
          onCancel={() => void cancelSplit()}
        />
      )}

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />{error}
        </div>
      )}

      {/* Documents écartés avant import. Information, pas alerte : l'utilisateur n'a
          rien à faire — c'est le comportement attendu, pas un problème à régler. */}
      {skipped.length > 0 && (
        <div className="mt-4 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-panel)] px-3 py-2.5 text-[13px] text-[var(--kn-text-muted)]">
          <p className="flex items-center gap-2">
            <FileText className="size-4 shrink-0" />
            <span>
              <span className="font-medium text-[var(--kn-text)]">
                {fmt(skipped.length)} document{skipped.length > 1 ? "s" : ""} écarté{skipped.length > 1 ? "s" : ""}
              </span>{" "}
              — ce ne sont pas des factures (récapitulatifs ou courriers). Aucun traitement
              n&apos;a été lancé dessus.
            </span>
          </p>
          <p className="mt-1 truncate pl-6 text-xs">
            {skipped.map((entry) => entry.name).join(", ")}
          </p>
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
              <div className="mb-1.5 flex items-center justify-between text-xs">
                <span className="text-[var(--kn-text-muted)]">
                  {fmt(trackedJobs.length)} document{trackedJobs.length > 1 ? "s" : ""} dans ce dépôt
                </span>
                <span className="font-semibold tabular-nums text-[var(--kn-text)]">{fmt(doneCount)}/{fmt(progressTotal)} · {progressPct} %</span>
              </div>

              {/* Barre segmentée : chaque segment = une étape du parcours, largeur
                  proportionnelle au nombre de documents qui s'y trouvent. Dit d'un
                  coup d'œil OÙ le lot est bloqué, ce qu'un pourcentage unique ne
                  pouvait pas exprimer. */}
              <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-[var(--kn-panel)]">
                {visibleStages.map((stage) => (
                  <div
                    key={stage.key}
                    className={`h-full transition-[width] duration-500 ${stage.className}`}
                    style={{ width: `${((stageCounts.get(stage.key) ?? 0) / (trackedJobs.length || 1)) * 100}%` }}
                    title={`${stage.label} : ${fmt(stageCounts.get(stage.key) ?? 0)}`}
                  />
                ))}
              </div>

              {/* Légende chiffrée — le vrai contenu informatif : couleur seule ne
                  suffit pas (contraste, daltonisme), chaque étape porte son compte. */}
              <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
                {visibleStages.map((stage) => (
                  <span key={stage.key} className="inline-flex items-center gap-1.5 text-xs text-[var(--kn-text-muted)]">
                    <span className={`size-2 shrink-0 rounded-full ${stage.dotClassName}`} aria-hidden />
                    <span className="font-semibold tabular-nums text-[var(--kn-text)]">{fmt(stageCounts.get(stage.key) ?? 0)}</span>
                    {stage.label}
                  </span>
                ))}
              </div>

              {/* Action directe quand des documents attendent une révision : évite de
                  chercher le premier dans la liste plus bas. */}
              {reviewPendingCount > 0 && firstReviewJobId && (
                <button
                  type="button"
                  onClick={() => router.push(`/upload/review?job=${firstReviewJobId}`)}
                  className="mt-3 flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-[#f97316] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                >
                  <FileText className="size-4" />
                  Réviser {fmt(reviewPendingCount)} document{reviewPendingCount > 1 ? "s" : ""}
                </button>
              )}

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

          {/* Les factures douteuses ne sont plus listées ici : au-delà de quelques
              unités, une liste inline dans un panneau de résumé devient illisible et
              se perd au rechargement. Elles ont leur écran dédié, qui les rassemble
              toutes — y compris celles des imports précédents. */}
          {lowConfidenceSaved.length > 0 && (
            <div className="mt-3">
              <Link
                href="/corrections"
                className="flex items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-900 transition-colors hover:bg-amber-100"
              >
                <span className="inline-flex items-center gap-2">
                  <AlertCircle className="size-4 shrink-0" />
                  <span>
                    <span className="font-semibold">{fmt(lowConfidenceSaved.length)} facture{lowConfidenceSaved.length > 1 ? "s" : ""}</span> {lowConfidenceSaved.length > 1 ? "ont" : "a"} été lue{lowConfidenceSaved.length > 1 ? "s" : ""} avec un doute
                  </span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-1 font-semibold">
                  Vérifier <ExternalLink className="size-3.5" />
                </span>
              </Link>
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
        {/* Appel à l'action, avant la liste.
            Le défaut de l'écran précédent : 44 documents listés à égalité, alors que la
            plupart n'attendaient rien de l'utilisateur. Ce bloc isole la seule chose qui
            demande son intervention, et l'ouvre en un clic sur le flux de révision
            enchaîné — plutôt que de le laisser chercher dans la liste. */}
        {pendingReviewJobs.length > 0 && (
          <button
            type="button"
            onClick={() => router.push(`/upload/review?job=${pendingReviewJobs[0].id}`)}
            className="mb-4 flex w-full cursor-pointer items-center gap-3 rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3.5 text-left transition-colors hover:border-[#f97316]"
          >
            <CheckCircle2 className="size-6 shrink-0 text-amber-600" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-amber-900">
                {fmt(pendingReviewJobs.length)} document{pendingReviewJobs.length > 1 ? "s" : ""} bloqué{pendingReviewJobs.length > 1 ? "s" : ""} — informations manquantes
              </span>
              <span className="mt-0.5 block text-xs text-amber-800">
                {pendingReviewJobs.length > 1 ? "Ces factures ne sont pas" : "Cette facture n’est pas"} encore enregistrée{pendingReviewJobs.length > 1 ? "s" : ""} :
                complétez ce qui manque pour {pendingReviewJobs.length > 1 ? "les" : "l’"}ajouter. Le document suivant s&apos;ouvre automatiquement.
              </span>
            </span>
            <span className="shrink-0 rounded-lg bg-[#f97316] px-3.5 py-2 text-xs font-semibold text-white">
              Compléter
            </span>
          </button>
        )}

        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-[var(--kn-text)]">
            Documents importés
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
          <>
          {/* Pas de pagination ici, volontairement : la liste est virtualisée (une
              dizaine de lignes dans le DOM quel que soit le total), donc découper en
              pages résoudrait un problème de volume qui ne se pose plus, tout en
              obligeant l'utilisateur à retenir sa page. Ce dont il a besoin, c'est de
              se repérer — d'où ce compteur, annoncé aux lecteurs d'écran quand les
              filtres changent le nombre de résultats. */}
          <p aria-live="polite" className="mb-2 text-xs text-[var(--kn-text-muted)]">
            {filteredQueueJobs.length === queueJobs.length
              ? `${fmt(queueJobs.length)} document${queueJobs.length > 1 ? "s" : ""}`
              : `${fmt(filteredQueueJobs.length)} sur ${fmt(queueJobs.length)} document${queueJobs.length > 1 ? "s" : ""} affiché${filteredQueueJobs.length > 1 ? "s" : ""}`}
          </p>
          <div ref={queueListParentRef} className="max-h-[36rem] overflow-y-auto" style={{ contain: "layout paint style" }}>
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
                    <div className={`flex items-center gap-3 rounded-xl border bg-[var(--kn-card)] px-4 py-3 transition-colors ${
                      job.status === "needs_review" ? "border-amber-300" : "border-[var(--kn-border)]"
                    }`}>
                      {["direct_processing", "uploading_to_claude", "batched", "processing"].includes(job.status) ? <Loader2 className="size-5 shrink-0 animate-spin text-[#f97316]" />
                        : job.status === "needs_review" ? <CheckCircle2 className="size-5 shrink-0 text-emerald-600" />
                        : job.status === "failed" ? <AlertCircle className="size-5 shrink-0 text-red-600" />
                        : job.status === "rejected_non_invoice" ? <AlertCircle className="size-5 shrink-0 text-amber-600" /> : <Clock3 className="size-5 shrink-0 text-amber-600" />}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-[var(--kn-text)]">{job.original_name}</p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                          {/* Badge de statut : la couleur double le texte, jamais seule
                              (contraste/daltonisme) — le libellé reste toujours lisible. */}
                          <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${STAGE_BADGE_CLASS[STAGE_OF[job.status]]}`}>
                            {statusLabel[job.status] ?? job.status}
                          </span>
                          <span className="text-xs text-[var(--kn-text-muted)]">
                            {(job.file_size / 1024 / 1024).toFixed(1)} Mo
                            {job.attempt_count > 1 ? ` · tentative ${job.attempt_count}` : ""}
                            {job.status === "rejected_non_invoice" && job.prefilter_type ? ` · détecté comme ${prefilterTypeLabel[job.prefilter_type] ?? job.prefilter_type}` : ""}
                          </span>
                        </div>
                        {job.last_error && <p className="mt-1 line-clamp-2 text-xs text-red-600">{job.last_error}</p>}
                      </div>
                      {job.status === "needs_review" && (
                        <button onClick={() => router.push(`/upload/review?job=${job.id}`)} className="shrink-0 cursor-pointer rounded-lg bg-[#f97316] px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90">Compléter</button>
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
          </>
        )}
      </div>
    </div>
  );
}
