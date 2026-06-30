"use client";

import Link from "next/link";
import { Building2, Lightbulb, Check } from "lucide-react";
import type { InvoiceDoc } from "@/lib/data/invoices";
import { PdfThumb } from "./pdf-thumb";
import { ConfidenceBadge } from "./confidence-badge";
import { AnomalyTicker } from "./anomaly-ticker";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");
const eur = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const frDate = (d: string) => { const [y, m, j] = d.split("-"); return `${j}/${m}/${y}`; };

/** Carte « mini-facture » (vue galerie). Lien étendu pour ouvrir l'extraction ; ticker & case restent cliquables. */
export function DocumentCard({ doc, selected, onToggle }: { doc: InvoiceDoc; selected: boolean; onToggle: () => void }) {
  return (
    <div className={cx(
      "group relative overflow-hidden rounded-xl border bg-[var(--kn-card)] transition-all hover:shadow-md",
      selected ? "border-[#f97316] ring-1 ring-[#f97316]" : "border-[var(--kn-border)] hover:border-[#fb923c]",
    )}>
      {/* Lien étendu : clic sur la carte → extraction */}
      <Link href={`/documents/extraction?id=${doc.id}`} aria-label={`Ouvrir ${doc.number}`} className="absolute inset-0 z-0" />

      {/* case à cocher */}
      <button
        onClick={(e) => { e.preventDefault(); onToggle(); }}
        aria-label={selected ? "Désélectionner" : "Sélectionner"}
        className={cx(
          "absolute left-2.5 top-2.5 z-20 flex size-5 items-center justify-center rounded-md border transition-colors",
          selected ? "border-[#f97316] bg-[#f97316] text-white" : "border-[var(--kn-border)] bg-[var(--kn-card)]/90 text-transparent hover:border-[#f97316] group-hover:text-[var(--kn-text-muted)]",
        )}
      >
        <Check className="size-3.5" strokeWidth={3} />
      </button>

      {/* aperçu réel de la facture (1ʳᵉ page) */}
      <div className="pointer-events-none relative border-b border-[var(--kn-border)]">
        <PdfThumb url={doc.previewUrl} heightClass="h-36" />
      </div>

      {/* métadonnées (cliquent à travers vers le lien étendu, sauf le ticker) */}
      <div className="pointer-events-none relative z-10 p-3">
        <p className="truncate text-[13px] font-semibold text-[var(--kn-text)]">{doc.number}</p>
        <p className="mt-0.5 truncate text-[12px] text-[var(--kn-text-muted)]">{doc.site} · {doc.commune}</p>
        <div className="mt-2 flex items-center justify-between">
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--kn-value-box)] px-1.5 py-0.5 text-[10px] text-[var(--kn-text-muted)]">
            {doc.categorie === "batiment" ? <Building2 className="size-2.5" /> : <Lightbulb className="size-2.5" />}
            {frDate(doc.date)}
          </span>
          <span className="text-[13px] font-semibold tabular-nums text-[var(--kn-text)]">{eur(doc.totalTtc)}</span>
        </div>
        <div className="pointer-events-auto mt-2 empty:hidden">
          <AnomalyTicker invoiceId={doc.id} anomalies={doc.anomalies} />
        </div>
        <div className="mt-1.5 flex items-center justify-between border-t border-[var(--kn-border)] pt-1.5">
          <span className="text-[10px] uppercase tracking-wide text-[var(--kn-text-muted)]">Confiance</span>
          <ConfidenceBadge value={doc.confidence} className="text-[11px]" />
        </div>
      </div>
    </div>
  );
}
