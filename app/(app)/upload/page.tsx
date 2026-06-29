"use client";

import { useEffect, useRef, useState, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { UploadCloud, Loader2, CheckCircle2, Building2, Lightbulb } from "lucide-react";
import { formatEur, formatDate } from "@/lib/format";
import type { InvoiceExtraction } from "@/lib/anthropic/invoice-schema";

interface Commune { id: string; nom: string }
interface Site { id: string; nom: string; categorie: "batiment" | "eclairage_public"; pdl: string | null }

export default function UploadPage() {
  return <Suspense><UploadPageInner /></Suspense>;
}

function UploadPageInner() {
  const router = useRouter();
  const [communes, setCommunes] = useState<Commune[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [communeId, setCommuneId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ extraction: InvoiceExtraction; file_path: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/communes").then((r) => r.json()).then((j) => setCommunes(j.communes ?? []));
  }, []);

  useEffect(() => {
    if (!communeId) { setSites([]); setSiteId(""); return; }
    fetch(`/api/sites?commune_id=${communeId}`).then((r) => r.json()).then((j) => setSites(j.sites ?? []));
  }, [communeId]);

  const handleFile = useCallback(async (file: File) => {
    setLoading(true); setError(null); setResult(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/extract", { method: "POST", body: formData });
      const json = await res.json();
      if (!res.ok || json.error) { setError(json.error ?? "Erreur d'extraction OCR."); return; }
      setResult(json);
    } catch { setError("Erreur réseau lors de l'extraction."); }
    finally { setLoading(false); }
  }, []);

  const searchParams = useSearchParams();
  const pendingId = searchParams.get("pending");
  useEffect(() => {
    if (!pendingId) return;
    (async () => {
      const res = await fetch(`/api/pending/${pendingId}`);
      const json = await res.json();
      if (!res.ok || !json.signedUrl) { setError(json.error ?? "Dépôt introuvable."); return; }
      setCommuneId(json.pending.commune_id);
      const blob = await fetch(json.signedUrl).then((r) => r.blob());
      handleFile(new File([blob], json.pending.original_name ?? "facture.pdf", { type: blob.type || "application/pdf" }));
    })();
  }, [pendingId, handleFile]);

  async function handleSave() {
    if (!result || !siteId) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extraction: result.extraction, file_path: result.file_path, site_id: siteId }),
      });
      const json = await res.json();
      if (!res.ok || json.error) { setError(json.error ?? "Erreur d'enregistrement."); return; }
      if (pendingId) {
        await fetch(`/api/pending/${pendingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ processed: true }) });
      }
      router.push(`/factures/${json.invoice_id}`);
    } catch { setError("Erreur réseau lors de l'enregistrement."); }
    finally { setSaving(false); }
  }

  const canUpload = Boolean(siteId);
  const prec = result?.extraction.precision ?? null;
  const precBadge = (k: string) => prec && prec[k] != null
    ? <span className="ml-2 rounded-full bg-[var(--kn-yellow-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[#9a3412]">{Math.round(prec[k] * 100)}%</span>
    : null;

  return (
    <div className="mx-auto max-w-2xl px-8 py-6">
      <h1 className="font-heading text-2xl font-bold text-[#1a1a1a]">Importer une facture</h1>
      <p className="mb-6 text-[13px] text-[var(--kn-text-muted)]">PDF, PNG, JPEG ou WEBP — extraction automatique par l&apos;IA.</p>

      <div className="mb-4 grid grid-cols-2 gap-3 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-panel)] p-3">
        <div>
          <label className="mb-1 block text-[11px] font-medium text-[var(--kn-text-muted)]">Commune</label>
          <Select value={communeId} onValueChange={(v) => setCommuneId(v ?? "")}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Choisir une commune" /></SelectTrigger>
            <SelectContent>{communes.map((c) => <SelectItem key={c.id} value={c.id}>{c.nom}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium text-[var(--kn-text-muted)]">Site / point de livraison</label>
          <Select value={siteId} onValueChange={(v) => setSiteId(v ?? "")} disabled={!communeId}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Choisir un site" /></SelectTrigger>
            <SelectContent>
              {sites.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  <span className="flex items-center gap-1.5">
                    {s.categorie === "batiment" ? <Building2 className="size-3.5" /> : <Lightbulb className="size-3.5" />}
                    {s.nom} {s.pdl ? `(${s.pdl})` : ""}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {!result && (
        <div
          onDragOver={(e) => { e.preventDefault(); if (canUpload) setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!canUpload) return; const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
          onClick={() => canUpload && inputRef.current?.click()}
          className={`flex h-52 w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed transition-colors ${
            !canUpload ? "cursor-not-allowed border-[var(--kn-border)] bg-[var(--kn-panel)]"
            : dragOver ? "cursor-pointer border-[#f97316] bg-[var(--kn-yellow-soft)]"
            : "cursor-pointer border-[#c8ccd2] bg-white hover:border-[#f97316]"}`}
        >
          {loading ? (
            <>
              <Loader2 className="size-6 animate-spin text-[#f97316]" />
              <p className="text-sm text-[#1a1a1a]">Extraction en cours…</p>
            </>
          ) : (
            <>
              <UploadCloud className="size-7 text-[var(--kn-text-muted)]" />
              <p className="text-sm font-medium text-[#1a1a1a]">
                {canUpload ? "Glissez-déposez la facture ici, ou cliquez pour sélectionner" : "Choisissez d'abord une commune et un site"}
              </p>
              <p className="text-xs text-[var(--kn-text-muted)]">PDF, PNG, JPEG, WEBP</p>
            </>
          )}
        </div>
      )}

      <input ref={inputRef} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />

      {error && <p className="mt-3 text-sm text-[#d33]">{error}</p>}

      {result && (
        <div className="rounded-xl border border-[var(--kn-border)] bg-white p-4">
          <div className="mb-3 flex items-center gap-2 text-[#0f6e56]">
            <CheckCircle2 className="size-4" />
            <span className="text-sm font-medium">Extraction réussie — vérifiez avant d&apos;enregistrer</span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><span className="text-[var(--kn-text-muted)]">N° facture{precBadge("facture_number")}</span><p className="font-medium text-[#1a1a1a]">{result.extraction.invoice.facture_number}</p></div>
            <div><span className="text-[var(--kn-text-muted)]">Date{precBadge("facture_date")}</span><p className="font-medium text-[#1a1a1a]">{formatDate(result.extraction.invoice.facture_date)}</p></div>
            <div><span className="text-[var(--kn-text-muted)]">Total HT{precBadge("total_ht")}</span><p className="font-medium text-[#1a1a1a]">{formatEur(result.extraction.invoice.total_ht)}</p></div>
            <div><span className="text-[var(--kn-text-muted)]">Total TTC{precBadge("total_ttc")}</span><p className="font-medium text-[#1a1a1a]">{formatEur(result.extraction.invoice.total_ttc)}</p></div>
          </div>
          <div className="mt-4 flex gap-2">
            <button onClick={handleSave} disabled={saving}
              className="rounded-lg bg-[#1a1a1a] px-4 py-2 text-[13px] font-medium text-white hover:bg-black disabled:opacity-50">
              {saving ? "Enregistrement…" : "Enregistrer la facture"}
            </button>
            <button onClick={() => setResult(null)} disabled={saving}
              className="rounded-lg border border-[var(--kn-border)] px-4 py-2 text-[13px] font-medium text-[#1a1a1a] hover:bg-[var(--kn-active)] disabled:opacity-50">
              Annuler
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
