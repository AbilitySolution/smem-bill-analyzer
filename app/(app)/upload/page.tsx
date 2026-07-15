"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, Clock3, FileText, Loader2, RefreshCw, UploadCloud, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { DocumentJob, DocumentJobStatus } from "@/lib/types/document-job";

const ACCEPTED_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
const MAX_SIZE = 20 * 1024 * 1024;
const MAX_FILES = 200;
const UPLOAD_CHUNK_SIZE = 5;

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
  const [files, setFiles] = useState<File[]>([]);
  const [jobs, setJobs] = useState<DocumentJob[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const refreshJobs = useCallback(async () => {
    const response = await fetch("/api/document-jobs", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    setJobs(payload.jobs ?? []);
  }, []);

  useEffect(() => {
    const initial = setTimeout(() => void refreshJobs(), 0);
    const timer = setInterval(() => void refreshJobs(), 3000);
    return () => { clearTimeout(initial); clearInterval(timer); };
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

  function addFiles(incoming: File[]) {
    setError(null);
    const valid: File[] = [];
    for (const file of incoming) {
      if (!ACCEPTED_TYPES.has(file.type)) {
        setError(`${file.name} : format non supporté.`);
        continue;
      }
      if (!file.size || file.size > MAX_SIZE) {
        setError(`${file.name} : le fichier doit faire moins de 20 Mo.`);
        continue;
      }
      valid.push(file);
    }
    setFiles((current) => {
      const merged = [...current];
      for (const file of valid) {
        if (!merged.some((item) => item.name === file.name && item.size === file.size)) merged.push(file);
      }
      if (merged.length > MAX_FILES) setError(`Maximum ${MAX_FILES} fichiers par envoi.`);
      return merged.slice(0, MAX_FILES);
    });
  }

  async function submit() {
    if (!files.length || submitting) return;
    setSubmitting(true);
    setUploadedCount(0);
    setError(null);

    try {
      for (let offset = 0; offset < files.length; offset += UPLOAD_CHUNK_SIZE) {
        const chunk = files.slice(offset, offset + UPLOAD_CHUNK_SIZE);
        const formData = new FormData();
        chunk.forEach((file) => formData.append("files", file));
        const response = await fetch("/api/document-jobs", { method: "POST", body: formData });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Impossible de mettre les documents en file.");
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

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="font-heading text-2xl font-bold text-[var(--kn-text)]">Importer des factures</h1>
      <p className="mb-7 text-[13px] text-[var(--kn-text-muted)]">
        Ajoutez jusqu&apos;à {MAX_FILES} documents. Ils seront regroupés en sous-batches Claude et resteront visibles même si vous quittez cette page.
      </p>

      <div
        onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => { event.preventDefault(); setDragOver(false); addFiles(Array.from(event.dataTransfer.files)); }}
        onClick={() => inputRef.current?.click()}
        className={`flex min-h-44 cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed transition-colors ${dragOver ? "border-[#f97316] bg-[var(--kn-yellow-soft)]" : "border-[#c8ccd2] bg-[var(--kn-card)] hover:border-[#f97316]"}`}
      >
        <UploadCloud className="size-8 text-[var(--kn-text-muted)]" />
        <div className="text-center">
          <p className="text-sm font-medium text-[var(--kn-text)]">Glissez vos factures ici ou cliquez</p>
          <p className="text-xs text-[var(--kn-text-muted)]">PDF, PNG, JPEG ou WEBP · 20 Mo maximum par fichier</p>
        </div>
      </div>
      <input ref={inputRef} type="file" multiple accept="application/pdf,image/png,image/jpeg,image/webp" className="hidden"
        onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />

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
