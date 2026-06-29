"use client";

import { useState } from "react";
import { Download, Link2, ExternalLink, FileSpreadsheet, Check, Settings2 } from "lucide-react";
import { downloadCsv } from "@/lib/csv";

/** Menu d'actions façon Odoo : télécharger PDF, obtenir le lien, ouvrir, exporter CSV. */
export function FactureActions({
  pdfUrl,
  filename,
  csvName,
  csvData,
}: {
  pdfUrl: string | null;
  filename: string;
  csvName: string;
  csvData: (string | number | null)[][];
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    if (!pdfUrl) return;
    try {
      await navigator.clipboard.writeText(pdfUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard indisponible */
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-lg border border-[var(--kn-border)] bg-white px-3 py-1.5 text-[13px] font-medium text-[#1a1a1a] transition-colors hover:bg-[var(--kn-active)]"
      >
        <Settings2 className="size-3.5" /> Actions
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1.5 w-56 overflow-hidden rounded-xl border border-[var(--kn-border)] bg-white py-1 text-[13px] shadow-lg">
            <a
              href={pdfUrl ?? undefined}
              download={filename}
              aria-disabled={!pdfUrl}
              className={`flex items-center gap-2.5 px-3 py-2 ${pdfUrl ? "hover:bg-[var(--kn-active)]" : "pointer-events-none opacity-40"}`}
            >
              <Download className="size-4 text-[var(--kn-text-muted)]" /> Télécharger le PDF
            </a>
            <button
              onClick={copyLink}
              disabled={!pdfUrl}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${pdfUrl ? "hover:bg-[var(--kn-active)]" : "opacity-40"}`}
            >
              {copied ? <Check className="size-4 text-[#0f6e56]" /> : <Link2 className="size-4 text-[var(--kn-text-muted)]" />}
              {copied ? "Lien copié !" : "Obtenir le lien"}
            </button>
            <a
              href={pdfUrl ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              aria-disabled={!pdfUrl}
              className={`flex items-center gap-2.5 px-3 py-2 ${pdfUrl ? "hover:bg-[var(--kn-active)]" : "pointer-events-none opacity-40"}`}
            >
              <ExternalLink className="size-4 text-[var(--kn-text-muted)]" /> Ouvrir dans un onglet
            </a>
            <div className="my-1 border-t border-[var(--kn-border)]" />
            <button
              onClick={() => { downloadCsv(csvName, csvData); setOpen(false); }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-[var(--kn-active)]"
            >
              <FileSpreadsheet className="size-4 text-[var(--kn-text-muted)]" /> Télécharger en CSV
            </button>
          </div>
        </>
      )}
    </div>
  );
}
