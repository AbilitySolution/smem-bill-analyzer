"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Archive, CheckCircle2, Clock3, FileText, FolderOpen, Loader2, RefreshCw, UploadCloud, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  estimateForDocumentCount,
  estimateRemainingForJobs,
  type ProcessingEstimateStats,
} from "@/lib/document-processing-estimate";
import type { DocumentJob, DocumentJobStatus } from "@/lib/types/document-job";

const ACCEPTED_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
const ACCEPTED_EXTENSIONS = new Map([
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
]);
const MAX_SIZE = 20 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_ARCHIVE_SIZE = 100 * 1024 * 1024;
const MAX_TOTAL_SIZE = 500 * 1024 * 1024;
const UPLOAD_CHUNK_SIZE = 5;
const FALLBACK_REFRESH_MS = 60_000;
const ACTIVE_UPLOAD_STORAGE_KEY = "smem-active-document-job-ids";

type RealtimeStatus = "connecting" | "live" | "recovering";

function extensionOf(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function isZip(file: File) {
  return file.type === "application/zip" || file.type === "application/x-zip-compressed" || extensionOf(file.name) === "zip";
}

async function detectedDocumentType(file: File) {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

const statusLabel: Record<DocumentJobStatus, string> = {
  queued: "En attente",
  uploading_to_claude: "Préparation Claude",
  batched: "Batch Claude en cours",
  processing: "Extraction OCR",
  needs_review: "À réviser",
  completed: "Terminé",
  failed: "Échec",
};

export default function UploadPage() {
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
  const [now, setNow] = useState(() => Date.now());
  const jobsRef = useRef<DocumentJob[]>([]);

  useEffect(() => {
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
    const response = await fetch("/api/document-jobs", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    setJobs(payload.jobs ?? []);
    if (payload.estimation) setEstimationStats(payload.estimation);
  }, []);

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
        return next.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, MAX_FILES);
      });
    }

    void (async () => {
      await refreshJobs();
      const { data } = await supabase.auth.getUser();
      if (cancelled || !data.user) return;

      channel = supabase
        .channel(`document-jobs-${data.user.id}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "document_jobs", filter: `created_by=eq.${data.user.id}` },
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
      const hasActiveJobs = jobsRef.current.some((job) => !["needs_review", "completed", "failed"].includes(job.status));
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
  }, [refreshJobs]);

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

  async function addFiles(incoming: File[]) {
    if (inspecting || submitting) return;
    setInspecting(true);
    setError(null);
    const valid: File[] = [];
    const rejected: string[] = [];
    let inspectedBytes = 0;

    async function inspectDocument(file: File, displayName = file.name) {
      if (valid.length >= MAX_FILES) {
        rejected.push(`${displayName} : limite de ${MAX_FILES} documents atteinte`);
        return;
      }
      if (!file.size || file.size > MAX_SIZE) {
        rejected.push(`${displayName} : taille vide ou supérieure à 20 Mo`);
        return;
      }
      if (inspectedBytes + file.size > MAX_TOTAL_SIZE) {
        rejected.push(`${displayName} : la sélection dépasse la limite totale de 500 Mo`);
        return;
      }

      const extensionType = ACCEPTED_EXTENSIONS.get(extensionOf(displayName));
      const detectedType = await detectedDocumentType(file);
      if (!extensionType || !detectedType || extensionType !== detectedType || !ACCEPTED_TYPES.has(detectedType)) {
        rejected.push(`${displayName} : contenu ou extension non supporté`);
        return;
      }

      valid.push(new File([file], displayName, { type: detectedType, lastModified: file.lastModified }));
      inspectedBytes += file.size;
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
          const entries = Object.values(archive.files).filter((entry) =>
            !entry.dir && !entry.name.startsWith("__MACOSX/") && !entry.name.split("/").some((part) => part.startsWith(".")),
          );

          for (const entry of entries) {
            if (valid.length >= MAX_FILES) {
              rejected.push(`${file.name} : seuls les ${MAX_FILES} premiers documents valides sont acceptés`);
              break;
            }
            const declaredSize = (entry as typeof entry & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
            if (declaredSize !== undefined && declaredSize > MAX_SIZE) {
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
          if (!merged.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) merged.push(file);
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

  async function submit() {
    if (!files.length || submitting) return;
    setSubmitting(true);
    setUploadedCount(0);
    setError(null);
    setActiveUploadJobIds([]);
    window.localStorage.removeItem(ACTIVE_UPLOAD_STORAGE_KEY);
    const submittedJobIds: string[] = [];

    try {
      for (let offset = 0; offset < files.length; offset += UPLOAD_CHUNK_SIZE) {
        const chunk = files.slice(offset, offset + UPLOAD_CHUNK_SIZE);
        const formData = new FormData();
        chunk.forEach((file) => formData.append("files", file));
        const response = await fetch("/api/document-jobs", { method: "POST", body: formData });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Impossible de mettre les documents en file.");
        submittedJobIds.push(...(payload.jobs ?? []).map((job: { id: string }) => job.id));
        setActiveUploadJobIds([...submittedJobIds]);
        window.localStorage.setItem(ACTIVE_UPLOAD_STORAGE_KEY, JSON.stringify(submittedJobIds));
        setUploadedCount(Math.min(offset + chunk.length, files.length));
      }
      setFiles([]);
      await refreshJobs();

      // Démarrage immédiat opportuniste. Supabase Cron reste le filet de sécurité
      // si l'onglet est fermé ou si cette invocation échoue.
      const supabase = createClient();
      void supabase.functions.invoke("process-document-queue").finally(() => void refreshJobs());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Erreur réseau.");
    } finally {
      setSubmitting(false);
    }
  }

  async function retry(jobId: string) {
    const response = await fetch(`/api/document-jobs/${jobId}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "retry" }),
    });
    const payload = await response.json();
    if (!response.ok) setError(payload.error ?? "Nouvelle tentative impossible.");
    await refreshJobs();
    if (response.ok) void createClient().functions.invoke("process-document-queue").finally(() => void refreshJobs());
  }

  const fallbackActiveJobs = jobs.filter((job) => !["needs_review", "completed", "failed"].includes(job.status));
  const trackedJobs = activeUploadJobIds.length
    ? jobs.filter((job) => activeUploadJobIds.includes(job.id))
    : fallbackActiveJobs;
  const activeTrackedJobs = trackedJobs.filter((job) => !["needs_review", "completed", "failed"].includes(job.status));
  const estimate = activeTrackedJobs.length
    ? estimateRemainingForJobs(activeTrackedJobs, estimationStats, now)
    : estimateForDocumentCount(files.length, estimationStats);
  const sentToClaude = trackedJobs.filter((job) => ["batched", "processing", "needs_review", "completed"].includes(job.status)).length;
  const ocrCompleted = trackedJobs.filter((job) => ["needs_review", "completed"].includes(job.status)).length;
  const failedCount = trackedJobs.filter((job) => job.status === "failed").length;
  const trackedTotal = Math.max(trackedJobs.length, submitting ? uploadedCount : 0);
  const progressStages = [
    { label: "Documents reçus", value: trackedTotal },
    { label: "Envoyés à Claude Batch", value: sentToClaude },
    { label: "OCR terminé · prêts à réviser", value: ocrCompleted },
  ];

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="font-heading text-2xl font-bold text-[var(--kn-text)]">Importer des factures</h1>
      <p className="mb-7 text-[13px] text-[var(--kn-text-muted)]">
        Ajoutez jusqu&apos;à {MAX_FILES} documents. Ils seront regroupés en sous-batches Claude et resteront visibles même si vous quittez cette page.
      </p>

      <div
        onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => { event.preventDefault(); setDragOver(false); void addFiles(Array.from(event.dataTransfer.files)); }}
        className={`flex min-h-44 flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed transition-colors ${dragOver ? "border-[#f97316] bg-[var(--kn-yellow-soft)]" : "border-[#c8ccd2] bg-[var(--kn-card)]"}`}
      >
        {inspecting ? <Loader2 className="size-8 animate-spin text-[#f97316]" /> : <UploadCloud className="size-8 text-[var(--kn-text-muted)]" />}
        <div className="text-center">
          <p className="text-sm font-medium text-[var(--kn-text)]">{inspecting ? "Vérification des fichiers…" : "Glissez vos factures ou une archive ZIP ici"}</p>
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
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-[var(--kn-text)]">{files.length} fichier{files.length > 1 ? "s" : ""} prêt{files.length > 1 ? "s" : ""}</p>
            <button onClick={() => setFiles([])} className="text-xs text-[var(--kn-text-muted)] hover:text-[var(--kn-text)]">Tout retirer</button>
          </div>
          <div className="space-y-1.5">
            {files.map((file, index) => (
              <div key={`${file.name}-${file.size}`} className="flex items-center gap-2 rounded-lg bg-[var(--kn-panel)] px-3 py-2 text-sm">
                <FileText className="size-4 text-[#f97316]" />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <span className="text-xs text-[var(--kn-text-muted)]">{(file.size / 1024 / 1024).toFixed(1)} Mo</span>
                <button aria-label={`Retirer ${file.name}`} onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}><X className="size-4" /></button>
              </div>
            ))}
          </div>
          <button disabled={submitting} onClick={submit} className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-[#f97316] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <UploadCloud className="size-4" />}
            {submitting ? `Envoi vers Supabase… ${uploadedCount}/${files.length}` : "Ajouter à la file d’attente"}
          </button>
        </div>
      )}

      {error && <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</div>}

      {(estimate || trackedJobs.length > 0) && (
        <div className="mt-4 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-[var(--kn-text)]">
                {activeTrackedJobs.length ? "Traitement en cours" : trackedJobs.length ? "Traitement terminé" : "Estimation avant envoi"}
              </p>
              {estimate && (
                <p className="mt-0.5 text-lg font-bold text-[#f97316]">
                  Environ {estimate.minimumMinutes}–{estimate.maximumMinutes} min
                  {activeTrackedJobs.length ? " restantes" : ""}
                </p>
              )}
              <p className="mt-1 text-xs text-[var(--kn-text-muted)]">
                {estimationStats?.source === "historical"
                  ? `Estimation basée sur ${estimationStats.sampleCount} batches terminés récemment.`
                  : "Estimation prudente initiale, recalibrée automatiquement après 5 batches terminés."}
              </p>
            </div>
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${realtimeStatus === "live" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
              {realtimeStatus === "live" ? "Suivi en direct" : realtimeStatus === "connecting" ? "Connexion au suivi…" : "Reconnexion au suivi…"}
            </span>
          </div>

          {trackedJobs.length > 0 && (
            <div className="mt-4 space-y-3">
              {progressStages.map((stage) => (
                <div key={stage.label}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="text-[var(--kn-text-muted)]">{stage.label}</span>
                    <span className="font-semibold text-[var(--kn-text)]">{stage.value}/{trackedTotal || trackedJobs.length}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-[var(--kn-panel)]">
                    <div className="h-full rounded-full bg-[#f97316] transition-[width] duration-500" style={{ width: `${trackedTotal ? Math.min(100, (stage.value / trackedTotal) * 100) : 0}%` }} />
                  </div>
                </div>
              ))}
              {failedCount > 0 && <p className="text-xs font-medium text-red-600">{failedCount} document{failedCount > 1 ? "s" : ""} en échec — vous pouvez les relancer individuellement.</p>}
            </div>
          )}
        </div>
      )}

      <div className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--kn-text)]">File de traitement</h2>
          <button onClick={() => void refreshJobs()} className="flex items-center gap-1 text-xs text-[var(--kn-text-muted)] hover:text-[var(--kn-text)]"><RefreshCw className="size-3.5" />Actualiser</button>
        </div>
        <div className="space-y-2">
          {jobs.map((job) => (
            <div key={job.id} className="flex items-center gap-3 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] px-4 py-3">
              {["uploading_to_claude", "batched", "processing"].includes(job.status) ? <Loader2 className="size-5 animate-spin text-[#f97316]" />
                : job.status === "needs_review" || job.status === "completed" ? <CheckCircle2 className="size-5 text-emerald-600" />
                : job.status === "failed" ? <AlertCircle className="size-5 text-red-600" /> : <Clock3 className="size-5 text-amber-600" />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-[var(--kn-text)]">{job.original_name}</p>
                <p className="text-xs text-[var(--kn-text-muted)]">{statusLabel[job.status]}{job.attempt_count ? ` · tentative ${job.attempt_count}` : ""}</p>
                {job.last_error && <p className="mt-1 line-clamp-2 text-xs text-red-600">{job.last_error}</p>}
              </div>
              {job.status === "needs_review" && <button onClick={() => router.push(`/upload/review?job=${job.id}`)} className="rounded-lg bg-[#f97316] px-3 py-1.5 text-xs font-semibold text-white">Réviser</button>}
              {job.status === "failed" && <button onClick={() => void retry(job.id)} className="rounded-lg border border-[var(--kn-border)] px-3 py-1.5 text-xs font-semibold"><RefreshCw className="mr-1 inline size-3" />Réessayer</button>}
            </div>
          ))}
          {!jobs.length && <div className="rounded-xl border border-dashed border-[var(--kn-border)] px-4 py-8 text-center text-sm text-[var(--kn-text-muted)]">Aucun document dans la file.</div>}
        </div>
      </div>
    </div>
  );
}
