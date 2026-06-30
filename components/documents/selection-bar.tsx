"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Trash2, Download, Sheet, X, Loader2, AlertTriangle } from "lucide-react";
import type { InvoiceDoc } from "@/lib/data/invoices";
import { archiveInvoices, deleteInvoices, getSignedUrls } from "@/app/(app)/documents/actions";

export function SelectionBar({ selectedDocs, onClear }: { selectedDocs: InvoiceDoc[]; onClear: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<null | "pdf">(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const ids = selectedDocs.map((d) => d.id);
  const withPdf = selectedDocs.filter((d) => d.filePath);
  const hasActive = selectedDocs.some((d) => !d.archived);
  const hasArchived = selectedDocs.some((d) => d.archived);

  function flash(text: string) { setMsg(text); setTimeout(() => setMsg(null), 2500); }

  function handleArchive(archived: boolean) {
    startTransition(async () => {
      const res = await archiveInvoices(ids, archived);
      if (res.error) flash(res.error);
      else { onClear(); router.refresh(); }
    });
  }

  function handleDelete() {
    startTransition(async () => {
      const res = await deleteInvoices(ids);
      setConfirmDelete(false);
      if (res.error) flash(res.error);
      else { onClear(); router.refresh(); }
    });
  }

  function handleExcel() {
    router.push(`/rapport-excel?ids=${ids.join(",")}`);
  }

  async function handleDownloadPdf() {
    if (!withPdf.length) { flash("Aucun PDF attaché aux factures sélectionnées."); return; }
    setBusy("pdf");
    try {
      const { files, error } = await getSignedUrls(withPdf.map((d) => d.id));
      if (error || !files.length) { flash(error ?? "Aucun fichier disponible."); return; }
      if (files.length === 1) {
        const a = document.createElement("a");
        a.href = files[0].url; a.download = files[0].filename; a.click();
      } else {
        const JSZip = (await import("jszip")).default;
        const zip = new JSZip();
        await Promise.all(files.map(async (f) => {
          const blob = await fetch(f.url).then((r) => r.blob());
          zip.file(f.filename, blob);
        }));
        const out = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(out);
        const a = document.createElement("a");
        a.href = url; a.download = `factures-${files.length}.zip`; a.click();
        URL.revokeObjectURL(url);
      }
      if (files.length < withPdf.length) flash(`${withPdf.length - files.length} fichier(s) introuvable(s) ignoré(s).`);
    } finally {
      setBusy(null);
    }
  }

  const btn = "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-50";

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
        <div className="pointer-events-auto flex flex-wrap items-center gap-1.5 rounded-2xl border border-[var(--kn-border)] bg-[var(--kn-card)] px-3 py-2 shadow-[0_8px_30px_rgba(0,0,0,0.12)]">
          <span className="mr-1 flex items-center gap-2 rounded-lg bg-[var(--kn-solid)] px-2.5 py-1.5 text-[13px] font-semibold text-white">
            {selectedDocs.length}
            <span className="font-normal text-white/70">sélectionnée{selectedDocs.length > 1 ? "s" : ""}</span>
          </span>

          {hasActive && (
            <button onClick={() => handleArchive(true)} disabled={pending} className={`${btn} text-[var(--kn-text)] hover:bg-[var(--kn-active)]`}>
              <EyeOff className="size-4 text-[var(--kn-text-muted)]" /> Masquer
            </button>
          )}
          {hasArchived && (
            <button onClick={() => handleArchive(false)} disabled={pending} className={`${btn} text-[var(--kn-text)] hover:bg-[var(--kn-active)]`}>
              <Eye className="size-4 text-[var(--kn-text-muted)]" /> Démasquer
            </button>
          )}
          <button onClick={handleDownloadPdf} disabled={!!busy || !withPdf.length} className={`${btn} text-[var(--kn-text)] hover:bg-[var(--kn-active)]`} title={withPdf.length ? "" : "Aucun PDF attaché"}>
            {busy === "pdf" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4 text-[var(--kn-text-muted)]" />}
            Télécharger PDF{withPdf.length ? ` (${withPdf.length})` : ""}
          </button>
          <button onClick={handleExcel} className={`${btn} bg-[#f97316] text-white hover:bg-[#ea580c]`}>
            <Sheet className="size-4" /> Exporter Excel
          </button>
          <button onClick={() => setConfirmDelete(true)} disabled={pending} className={`${btn} text-[#b91c1c] hover:bg-[#fef2f2]`}>
            <Trash2 className="size-4" /> Supprimer
          </button>

          <div className="mx-0.5 h-6 w-px bg-[var(--kn-border)]" />
          <button onClick={onClear} className="rounded-lg p-1.5 text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]" title="Tout désélectionner">
            <X className="size-4" />
          </button>
        </div>
      </div>

      {msg && (
        <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center">
          <span className="pointer-events-auto rounded-lg bg-[var(--kn-solid)] px-3 py-1.5 text-[12px] text-white shadow-lg">{msg}</span>
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !pending && setConfirmDelete(false)}>
          <div className="w-full max-w-sm rounded-2xl bg-[var(--kn-card)] p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center gap-2 text-[#b91c1c]">
              <AlertTriangle className="size-5" />
              <h3 className="font-heading text-[15px] font-bold">Supprimer {selectedDocs.length} facture{selectedDocs.length > 1 ? "s" : ""} ?</h3>
            </div>
            <p className="mb-4 text-[13px] text-[var(--kn-text-muted)]">
              Cette action est définitive : la facture, ses lignes de consommation, taxes et le PDF associé seront supprimés. Pour masquer sans supprimer, utilisez « Masquer ».
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(false)} disabled={pending} className="rounded-lg border border-[var(--kn-border)] px-3 py-1.5 text-[13px] font-medium hover:bg-[var(--kn-active)]">Annuler</button>
              <button onClick={handleDelete} disabled={pending} className="flex items-center gap-1.5 rounded-lg bg-[#b91c1c] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[#991b1b] disabled:opacity-50">
                {pending && <Loader2 className="size-4 animate-spin" />} Supprimer définitivement
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
