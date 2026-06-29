"use client";

import { useMemo, useState } from "react";
import {
  Search,
  Download,
  FileText,
  Building2,
  Lightbulb,
  ChevronsUpDown,
  ChevronUp,
  ChevronDown,
  FileWarning,
} from "lucide-react";
import type { InvoiceDoc } from "@/lib/data/invoices";
import { downloadCsv } from "@/lib/csv";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");
const eur = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const kwh = (n: number) => n.toLocaleString("fr-FR") + " kWh";
const catLabel = (c: string) => (c === "batiment" ? "Bâtiment" : "Éclairage public");
const frDate = (d: string) => {
  const [y, m, j] = d.split("-");
  return `${j}/${m}/${y}`;
};

type SortKey = "date" | "number" | "site" | "totalTtc" | "kwh";

export function ResultsView({ docs, isDemo }: { docs: InvoiceDoc[]; isDemo?: boolean }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "date", dir: -1 });
  const [selectedId, setSelectedId] = useState<string>(docs[0]?.id ?? "");

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    const list = docs.filter(
      (d) =>
        d.number.toLowerCase().includes(q) ||
        d.site.toLowerCase().includes(q) ||
        d.commune.toLowerCase().includes(q),
    );
    return [...list].sort((a, b) => {
      let cmp = 0;
      if (sort.key === "number") cmp = a.number.localeCompare(b.number);
      else if (sort.key === "site") cmp = a.site.localeCompare(b.site);
      else if (sort.key === "totalTtc") cmp = a.totalTtc - b.totalTtc;
      else if (sort.key === "kwh") cmp = a.kwh - b.kwh;
      else cmp = a.date.localeCompare(b.date);
      return cmp * sort.dir;
    });
  }, [docs, query, sort]);

  const selected = docs.find((d) => d.id === selectedId) ?? filtered[0] ?? docs[0];

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  function exportAll() {
    const headers = ["N° facture", "Date", "Site", "Commune", "Catégorie", "Duplicata", "Total HT (€)", "TVA (€)", "Total TTC (€)", "Conso (kWh)"];
    const rows = filtered.map((d) => [
      d.number, frDate(d.date), d.site, d.commune, catLabel(d.categorie), d.isDuplicata ? "Oui" : "Non",
      d.totalHt, d.tva, d.totalTtc, d.kwh,
    ]);
    downloadCsv("factures-electricite.csv", [headers, ...rows]);
  }

  function exportInvoice(d: InvoiceDoc) {
    const headers = ["Poste tarifaire", "Période", "Conso (kWh)", "Prix unitaire (c€/kWh)", "Montant (€)"];
    const rows = d.lines.length
      ? d.lines.map((l) => [l.poste, l.periode, l.kwh, l.prix ?? "", l.montant])
      : [["—", "—", "", "", ""]];
    downloadCsv(`facture-${d.number}.csv`, [
      [`Facture ${d.number}`, frDate(d.date), d.site, d.commune],
      ["Total HT", d.totalHt, "TVA", d.tva, "Total TTC", d.totalTtc],
      [],
      headers,
      ...rows,
    ]);
  }

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Topbar */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--kn-border)] px-4">
        <div className="flex items-center gap-2 text-[13px]">
          <FileText className="size-4 text-[var(--kn-text-muted)]" strokeWidth={1.75} />
          <span className="font-medium text-[#1a1a1a]">Facture d&apos;électricité</span>
          <span className="rounded-full bg-[var(--kn-value-box)] px-2 py-0.5 text-[11px] text-[var(--kn-text-muted)]">
            {docs.length} factures
          </span>
          {isDemo && (
            <span className="rounded-full bg-[var(--kn-yellow-soft)] px-2 py-0.5 text-[11px] font-medium text-[#9a3412]">
              Aperçu — vraies données affichées une fois connecté
            </span>
          )}
        </div>
        <button
          onClick={exportAll}
          className="flex items-center gap-1.5 rounded-lg bg-[#1a1a1a] px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-black"
        >
          <Download className="size-3.5" /> Exporter tout (CSV)
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Liste des factures */}
        <div className="flex w-[360px] shrink-0 flex-col border-r border-[var(--kn-border)]">
          <div className="border-b border-[var(--kn-border)] p-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--kn-text-muted)]" strokeWidth={1.75} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Rechercher (n°, site, commune)"
                className="h-9 w-full rounded-lg border border-[var(--kn-border)] pl-9 pr-3 text-[13px] focus:border-[#1a1a1a] focus:outline-none"
              />
            </div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--kn-text-muted)]">
              <span>Trier :</span>
              {([["date", "Date"], ["totalTtc", "Montant"], ["kwh", "kWh"]] as [SortKey, string][]).map(([k, label]) => (
                <button key={k} onClick={() => toggleSort(k)} className={cx("inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 hover:bg-[var(--kn-active)]", sort.key === k && "text-[#1a1a1a]")}>
                  {label}
                  {sort.key === k ? (sort.dir === 1 ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />) : <ChevronsUpDown className="size-3 opacity-40" />}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {filtered.map((d) => (
              <button
                key={d.id}
                onClick={() => setSelectedId(d.id)}
                className={cx(
                  "flex w-full flex-col gap-1 border-b border-[var(--kn-border)] px-3 py-2.5 text-left transition-colors",
                  selected?.id === d.id ? "bg-[var(--kn-yellow-soft)]" : "hover:bg-[var(--kn-active)]",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13px] font-semibold text-[#1a1a1a]">{d.number}</span>
                  <span className="shrink-0 text-[12px] font-medium tabular-nums text-[#1a1a1a]">{eur(d.totalTtc)}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[12px] text-[var(--kn-text-muted)]">{d.site} · {d.commune}</span>
                  <span className="shrink-0 text-[11px] text-[var(--kn-text-muted)]">{frDate(d.date)}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--kn-value-box)] px-1.5 py-0.5 text-[10px] text-[var(--kn-text-muted)]">
                    {d.categorie === "batiment" ? <Building2 className="size-2.5" /> : <Lightbulb className="size-2.5" />}
                    {catLabel(d.categorie)}
                  </span>
                  {d.kwh > 0 && <span className="text-[10px] text-[var(--kn-text-muted)]">{kwh(d.kwh)}</span>}
                  {d.isDuplicata && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#fef3c7] px-1.5 py-0.5 text-[10px] text-[#92400e]">
                      <FileWarning className="size-2.5" /> Duplicata
                    </span>
                  )}
                </div>
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="px-3 py-8 text-center text-[12px] text-[var(--kn-text-muted)]">Aucune facture ne correspond.</p>
            )}
          </div>
        </div>

        {/* Détail de la facture sélectionnée */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {selected && <InvoiceDetail doc={selected} onExport={() => exportInvoice(selected)} />}
        </div>
      </div>
    </div>
  );
}

function InvoiceDetail({ doc, onExport }: { doc: InvoiceDoc; onExport: () => void }) {
  const fields: { label: string; value: string }[] = [
    { label: "N° de facture", value: doc.number },
    { label: "Date de facture", value: frDate(doc.date) },
    { label: "Site", value: doc.site },
    { label: "Commune", value: doc.commune },
    { label: "Catégorie", value: catLabel(doc.categorie) },
    { label: "Total HT", value: eur(doc.totalHt) },
    { label: "TVA", value: eur(doc.tva) },
    { label: "Total TTC", value: eur(doc.totalTtc) },
    { label: "Consommation totale", value: doc.kwh > 0 ? kwh(doc.kwh) : "—" },
  ];

  return (
    <div className="px-6 py-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="font-heading text-[18px] font-bold text-[#1a1a1a]">{doc.number}</h2>
          <p className="text-[13px] text-[var(--kn-text-muted)]">{doc.site} · {doc.commune} · {frDate(doc.date)}</p>
        </div>
        <button
          onClick={onExport}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--kn-border)] bg-white px-3 py-1.5 text-[13px] font-medium text-[#1a1a1a] transition-colors hover:bg-[var(--kn-active)]"
        >
          <Download className="size-3.5" /> Exporter (CSV)
        </button>
      </div>

      <h3 className="mb-2 font-heading text-[14px] font-semibold text-[#1a1a1a]">Champs extraits</h3>
      <div className="mb-6 grid grid-cols-1 gap-x-6 md:grid-cols-2">
        {fields.map((f) => (
          <div key={f.label} className="flex items-center justify-between gap-4 border-b border-[var(--kn-border)] py-2.5">
            <span className="text-[13px] text-[var(--kn-text-muted)]">{f.label}</span>
            <span className="text-[13px] font-medium text-[#1a1a1a]">{f.value}</span>
          </div>
        ))}
      </div>

      <h3 className="mb-2 font-heading text-[14px] font-semibold text-[#1a1a1a]">Lignes de consommation</h3>
      {doc.lines.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--kn-border)] px-3 py-6 text-center text-[12px] text-[var(--kn-text-muted)]">
          Aucune ligne de consommation détaillée sur cette facture.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--kn-border)]">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-[var(--kn-border)] bg-[var(--kn-panel)] text-left text-[var(--kn-text-muted)]">
                <th className="px-3 py-2 font-medium">Poste tarifaire</th>
                <th className="px-3 py-2 font-medium">Période</th>
                <th className="px-3 py-2 text-right font-medium">Conso (kWh)</th>
                <th className="px-3 py-2 text-right font-medium">Prix (c€/kWh)</th>
                <th className="px-3 py-2 text-right font-medium">Montant</th>
              </tr>
            </thead>
            <tbody>
              {doc.lines.map((l, i) => (
                <tr key={i} className="border-b border-[var(--kn-border)] last:border-0 hover:bg-[var(--kn-active)]">
                  <td className="px-3 py-2 font-medium text-[#1a1a1a]">{l.poste}</td>
                  <td className="px-3 py-2 text-[var(--kn-text-muted)]">{l.periode}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.kwh.toLocaleString("fr-FR")}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.prix != null ? l.prix.toFixed(4) : "—"}</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{eur(l.montant)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
