"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ChevronRight, FileText, Building2, Lightbulb, Check, ScanText, MapPin,
} from "lucide-react";
import type { InvoiceDoc } from "@/lib/data/invoices";
import { PdfThumb } from "./pdf-thumb";
import { ConfidenceBadge } from "./confidence-badge";
import { AnomalyTicker } from "./anomaly-ticker";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");
const eur = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const kwhFmt = (n: number) => n.toLocaleString("fr-FR") + " kWh";
const catLabel = (c: string) => (c === "batiment" ? "Bâtiment" : "Éclairage public");
const frDate = (d: string) => { const [y, m, j] = d.split("-"); return `${j}/${m}/${y}`; };

function Tick({ on, onClick }: { on: boolean; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={on ? "Désélectionner" : "Sélectionner"}
      className={cx(
        "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
        on ? "border-[#f97316] bg-[#f97316] text-white" : "border-[var(--kn-border)] text-transparent hover:border-[#f97316]",
      )}
    >
      <Check className="size-3" strokeWidth={3} />
    </button>
  );
}

/** Vue colonnes façon Finder : communes → factures → aperçu. */
export function ColumnsView({ docs, selected, onToggle }: { docs: InvoiceDoc[]; selected: Set<string>; onToggle: (id: string) => void }) {
  const communes = useMemo(() => {
    const m = new Map<string, InvoiceDoc[]>();
    for (const d of docs) { (m.get(d.commune) ?? m.set(d.commune, []).get(d.commune)!).push(d); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [docs]);

  const [activeCommune, setActiveCommune] = useState<string | null>(communes[0]?.[0] ?? null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const invoices = communes.find(([c]) => c === activeCommune)?.[1] ?? [];
  const active = docs.find((d) => d.id === activeId) ?? null;

  return (
    <div className="grid h-full grid-cols-[minmax(180px,1fr)_minmax(220px,1.4fr)_minmax(240px,1.4fr)] gap-0 overflow-hidden rounded-xl border border-[var(--kn-border)]">
      {/* Colonne 1 — communes */}
      <div className="overflow-y-auto border-r border-[var(--kn-border)]">
        <p className="sticky top-0 bg-[var(--kn-panel)] px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">Communes</p>
        {communes.map(([c, items]) => (
          <button
            key={c}
            onClick={() => { setActiveCommune(c); setActiveId(null); }}
            className={cx(
              "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors",
              activeCommune === c ? "bg-[var(--kn-yellow-soft)] font-medium text-[var(--kn-text)]" : "text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)]",
            )}
          >
            <MapPin className={cx("size-3.5", activeCommune === c && "text-[#ea580c]")} />
            <span className="flex-1 truncate">{c}</span>
            <span className="rounded-full bg-[var(--kn-card)] px-1.5 text-[10px] text-[var(--kn-text-muted)]">{items.length}</span>
            <ChevronRight className="size-3.5 opacity-40" />
          </button>
        ))}
      </div>

      {/* Colonne 2 — factures */}
      <div className="overflow-y-auto border-r border-[var(--kn-border)]">
        <p className="sticky top-0 bg-[var(--kn-panel)] px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">Factures</p>
        {invoices.map((d) => (
          <div
            key={d.id}
            className={cx(
              "flex w-full items-center gap-2 px-3 py-2 text-[13px] transition-colors",
              activeId === d.id ? "bg-[var(--kn-yellow-soft)] text-[var(--kn-text)]" : "hover:bg-[var(--kn-active)]",
            )}
          >
            <Tick on={selected.has(d.id)} onClick={(e) => { e.stopPropagation(); onToggle(d.id); }} />
            <button onClick={() => setActiveId(d.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
              <FileText className="size-3.5 shrink-0 text-[#ea580c]" />
              <span className="flex-1 truncate font-medium">{d.number}</span>
            </button>
            <AnomalyTicker invoiceId={d.id} anomalies={d.anomalies} label={false} size="size-3.5" />
            <ChevronRight className="size-3.5 shrink-0 opacity-40" />
          </div>
        ))}
        {invoices.length === 0 && <p className="px-3 py-4 text-[12px] text-[var(--kn-text-muted)]">Sélectionnez une commune.</p>}
      </div>

      {/* Colonne 3 — aperçu */}
      <div className="overflow-y-auto">
        <p className="sticky top-0 bg-[var(--kn-panel)] px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">Aperçu</p>
        {active ? (
          <div className="p-4">
            <div className="mb-3 overflow-hidden rounded-lg border border-[var(--kn-border)]">
              <PdfThumb url={active.previewUrl} heightClass="h-40" iconSize="size-9" />
            </div>
            <p className="text-[14px] font-semibold text-[var(--kn-text)]">{active.number}</p>
            <p className="text-[12px] text-[var(--kn-text-muted)]">{active.site} · {active.commune}</p>
            <div className="mt-1.5 empty:hidden">
              <AnomalyTicker invoiceId={active.id} anomalies={active.anomalies} />
            </div>
            <dl className="mt-3 space-y-1.5 text-[12px]">
              <Line label="Date" value={frDate(active.date)} />
              <Line label="Catégorie" value={catLabel(active.categorie)} icon={active.categorie === "batiment" ? <Building2 className="size-3" /> : <Lightbulb className="size-3" />} />
              <Line label="Total HT" value={eur(active.totalHt)} />
              <Line label="TVA" value={eur(active.tva)} />
              <Line label="Total TTC" value={eur(active.totalTtc)} strong />
              <Line label="Consommation" value={active.kwh > 0 ? kwhFmt(active.kwh) : "—"} />
              <div className="flex items-center justify-between">
                <dt className="text-[var(--kn-text-muted)]">Confiance</dt>
                <dd><ConfidenceBadge value={active.confidence} /></dd>
              </div>
            </dl>
            <Link
              href={`/documents/extraction?id=${active.id}`}
              className="mt-4 flex items-center justify-center gap-1.5 rounded-lg bg-[#f97316] py-2 text-[13px] font-medium text-white transition-colors hover:bg-[#ea580c]"
            >
              <ScanText className="size-4" /> Ouvrir l&apos;extraction
            </Link>
          </div>
        ) : (
          <p className="px-3 py-4 text-[12px] text-[var(--kn-text-muted)]">Sélectionnez une facture pour l&apos;aperçu.</p>
        )}
      </div>
    </div>
  );
}

function Line({ label, value, strong, icon }: { label: string; value: string; strong?: boolean; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-[var(--kn-text-muted)]">{label}</dt>
      <dd className={cx("flex items-center gap-1 tabular-nums", strong ? "font-semibold text-[var(--kn-text)]" : "text-[var(--kn-text)]")}>{icon}{value}</dd>
    </div>
  );
}
