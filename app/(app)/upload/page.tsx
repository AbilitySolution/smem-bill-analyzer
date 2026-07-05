"use client";

import { useRef, useState, useCallback, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { UploadCloud, Loader2, AlertCircle } from "lucide-react";

export default function UploadPage() {
  return <Suspense><UploadPageInner /></Suspense>;
}

function UploadPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/extract", { method: "POST", body: formData });
      const json = await res.json();
      if (!res.ok || json.error) {
        setError(json.error ?? "Erreur d'extraction OCR.");
        setBusy(false);
        return;
      }
      // Store full OCR result, redirect to review form
      sessionStorage.setItem("upload_ocr_result", JSON.stringify(json));
      router.push("/upload/review");
    } catch {
      setError("Erreur réseau.");
      setBusy(false);
    }
  }, [router]);

  // Handle pending upload from external link
  const pendingId = searchParams.get("pending");
  useEffect(() => {
    if (!pendingId) return;
    (async () => {
      const res = await fetch(`/api/pending/${pendingId}`);
      const json = await res.json();
      if (!res.ok || !json.signedUrl) { setError(json.error ?? "Dépôt introuvable."); return; }
      const blob = await fetch(json.signedUrl).then((r) => r.blob());
      handleFile(new File([blob], json.pending.original_name ?? "facture.pdf", { type: blob.type || "application/pdf" }));
    })();
  }, [pendingId, handleFile]);

  return (
    <div className="mx-auto max-w-lg px-8 py-10">
      <h1 className="font-heading text-2xl font-bold text-[var(--kn-text)]">Importer une facture</h1>
      <p className="mb-8 text-[13px] text-[var(--kn-text-muted)]">
        Extraire les données automatiquement. Vous pourrez les vérifier et corriger avant l'enregistrement.
      </p>

      <div
        onDragOver={(e) => { e.preventDefault(); if (!busy) setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault(); setDragOver(false);
          if (busy) return;
          const f = e.dataTransfer.files[0]; if (f) handleFile(f);
        }}
        onClick={() => { if (!busy) inputRef.current?.click(); }}
        className={`flex h-56 w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed transition-colors ${
          busy ? "cursor-default border-[var(--kn-border)] bg-[var(--kn-panel)]"
          : dragOver ? "cursor-pointer border-[#f97316] bg-[var(--kn-yellow-soft)]"
          : "cursor-pointer border-[#c8ccd2] bg-[var(--kn-card)] hover:border-[#f97316]"
        }`}
      >
        {busy ? (
          <>
            <Loader2 className="size-7 animate-spin text-[#f97316]" />
            <p className="text-sm font-medium text-[var(--kn-text)]">Extraction des données en cours…</p>
          </>
        ) : (
          <>
            <UploadCloud className="size-8 text-[var(--kn-text-muted)]" />
            <div className="text-center">
              <p className="text-sm font-medium text-[var(--kn-text)]">Glissez la facture ici ou cliquez</p>
              <p className="text-xs text-[var(--kn-text-muted)]">PDF, PNG, JPEG, WEBP</p>
            </div>
          </>
        )}
      </div>

      <input ref={inputRef} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />

      {error && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </div>
      )}
    </div>
  );
}
