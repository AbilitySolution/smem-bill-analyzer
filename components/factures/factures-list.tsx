"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Search, Download, Building2, Lightbulb, ChevronsUpDown, ChevronUp, ChevronDown,
  ChevronRight, FileWarning, Layers,
} from "lucide-react";
import type { InvoiceDoc } from "@/lib/data/invoices";
import { downloadCsv } from "@/lib/csv";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");
const eur = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const kwhFmt = (n: number) => n.toLocaleString("fr-FR") + " kWh";
const catLabel = (c: string) => (c === "batiment" ? "Bâtiment" : "Éclairage public");
const frDate = (d: string) => { const [y, m, j] = d.split("-"); return `${j}/${m}/${y}`; };

type SortKey = "date" | "number" | "site" | "commune" | "kwh" | "totalTtc";
type CatFilter = "all" | "batiment" | "eclairage_public";
type GroupBy = "none" | "commune" | "site" | "categorie";

export function FacturesList({ docs, isDemo }: { docs: InvoiceDoc[]; isDemo?: boolean }) {
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<CatFilter>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "date", dir: -1 });
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const rows = useMemo(() => {
    const q = query.toLowerCase();
    const list = docs.filter(
      (d) => (cat === "all" || d.categorie === cat) &&
        (d.number.toLowerCase().includes(q) || d.site.toLowerCase().includes(q) || d.commune.toLowerCase().includes(q)),
    );
    return [...list].sort((a, b) => {
      let c = 0;
      if (sort.key === "number") c = a.number.localeCompare(b.number);
      else if (sort.key === "site") c = a.site.localeCompare(b.site);
      else if (sort.key === "commune") c = a.commune.localeCompare(b.commune);
      else if (sort.key === "kwh") c = a.kwh - b.kwh;
      else if (sort.key === "totalTtc") c = a.totalTtc - b.totalTtc;
      else c = a.date.localeCompare(b.date);
      return c * sort.dir;
    });
  }, [docs, query, cat, sort]);

  const groups = useMemo(() => {
    if (groupBy === "none") return null;
    const key = (d: InvoiceDoc) => (groupBy === "commune" ? d.commune : groupBy === "site" ? d.site : catLabel(d.categorie));
    const map = new Map<string, InvoiceDoc[]>();
    for (const d of rows) { const k = key(d); (map.get(k) ?? map.set(k, []).get(k)!).push(d); }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows, groupBy]);

  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  const toggleGroup = (k: string) => setCollapsed((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  function exportAll() {
    const headers = ["N° facture", "Date", "Site", "Commune", "Catégorie", "Duplicata", "Total HT (€)", "TVA (€)", "Total TTC (€)", "Conso (kWh)"];
    const data = rows.map((d) => [d.number, frDate(d.date), d.site, d.commune, catLabel(d.categorie), d.isDuplicata ? "Oui" : "Non", d.totalHt, d.tva, d.totalTtc, d.kwh]);
    downloadCsv("factures-electricite.csv", [headers, ...data]);
  }

  const SortBtn = ({ k, label, align }: { k: SortKey; label: string; align?: "right" }) => (
    <button onClick={() => toggleSort(k)} className={cx("inline-flex items-center gap-1 hover:text-[#1a1a1a]", align === "right" && "flex-row-reverse")}>
      {label}
      {sort.key === k ? (sort.dir === 1 ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />) : <ChevronsUpDown className="size-3 opacity-40" />}
    </button>
  );

  const Row = ({ d }: { d: InvoiceDoc }) => (
    <tr className="border-b border-[var(--kn-border)] last:border-0 hover:bg-[var(--kn-yellow-soft)]">
      <td className="px-4 py-0">
        <Link href={`/factures/${d.id}`} className="flex items-center gap-2 py-2.5 font-medium text-[#1a1a1a]">
          {d.number}{d.isDuplicata && <FileWarning className="size-3.5 text-[#b45309]" />}
        </Link>
      </td>
      <td className="px-4 py-2.5 text-[var(--kn-text-muted)]">{frDate(d.date)}</td>
      <td className="px-4 py-2.5">{d.site}</td>
      <td className="px-4 py-2.5 text-[var(--kn-text-muted)]">{d.commune}</td>
      <td className="px-4 py-2.5">
        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--kn-value-box)] px-2 py-0.5 text-[11px] text-[var(--kn-text-muted)]">
          {d.categorie === "batiment" ? <Building2 className="size-3" /> : <Lightbulb className="size-3" />}{catLabel(d.categorie)}
        </span>
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums text-[var(--kn-text-muted)]">{d.kwh > 0 ? kwhFmt(d.kwh) : "—"}</td>
      <td className="px-4 py-2.5 text-right font-medium tabular-nums">{eur(d.totalTtc)}</td>
    </tr>
  );

  return (
    <div className="px-8 py-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <h1 className="font-heading text-2xl font-bold text-[#1a1a1a]">Factures d&apos;électricité</h1>
          <span className="rounded-full bg-[var(--kn-value-box)] px-2 py-0.5 text-[12px] text-[var(--kn-text-muted)]">{rows.length}</span>
          {isDemo && <span className="rounded-full bg-[var(--kn-yellow-soft)] px-2 py-0.5 text-[11px] font-medium text-[#9a3412]">Aperçu — vraies données une fois connecté</span>}
        </div>
        <button onClick={exportAll} className="flex items-center gap-1.5 rounded-lg bg-[#1a1a1a] px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-black">
          <Download className="size-3.5" /> Exporter CSV
        </button>
      </div>

      {/* Barre d'outils : recherche + filtre + regroupement */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--kn-text-muted)]" strokeWidth={1.75} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher (n°, site, commune)"
            className="h-10 w-full rounded-lg border border-[var(--kn-border)] pl-9 pr-3 text-sm focus:border-[#1a1a1a] focus:outline-none" />
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-[var(--kn-border)] bg-white p-1 text-[13px]">
          {([["all", "Toutes"], ["batiment", "Bâtiments"], ["eclairage_public", "Éclairage"]] as [CatFilter, string][]).map(([v, label]) => (
            <button key={v} onClick={() => setCat(v)} className={cx("rounded-md px-2.5 py-1 font-medium transition-colors", cat === v ? "bg-[#1a1a1a] text-white" : "text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)]")}>{label}</button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 rounded-lg border border-[var(--kn-border)] bg-white px-2 py-1 text-[13px]">
          <Layers className="size-3.5 text-[var(--kn-text-muted)]" />
          <span className="text-[var(--kn-text-muted)]">Regrouper :</span>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)} className="bg-transparent font-medium text-[#1a1a1a] focus:outline-none">
            <option value="none">Aucun</option>
            <option value="commune">Commune</option>
            <option value="site">Site</option>
            <option value="categorie">Catégorie</option>
          </select>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--kn-border)]">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-[var(--kn-border)] bg-[var(--kn-panel)] text-left text-[var(--kn-text-muted)]">
              <th className="px-4 py-2.5 font-medium"><SortBtn k="number" label="N° facture" /></th>
              <th className="px-4 py-2.5 font-medium"><SortBtn k="date" label="Date" /></th>
              <th className="px-4 py-2.5 font-medium"><SortBtn k="site" label="Site" /></th>
              <th className="px-4 py-2.5 font-medium"><SortBtn k="commune" label="Commune" /></th>
              <th className="px-4 py-2.5 font-medium">Catégorie</th>
              <th className="px-4 py-2.5 text-right font-medium"><SortBtn k="kwh" label="Conso" align="right" /></th>
              <th className="px-4 py-2.5 text-right font-medium"><SortBtn k="totalTtc" label="Total TTC" align="right" /></th>
            </tr>
          </thead>
          <tbody>
            {/* Vue plate */}
            {!groups && rows.map((d) => <Row key={d.id} d={d} />)}

            {/* Vue groupée */}
            {groups && groups.map(([label, items]) => {
              const isCollapsed = collapsed.has(label);
              const sumTtc = items.reduce((s, d) => s + d.totalTtc, 0);
              const sumKwh = items.reduce((s, d) => s + d.kwh, 0);
              return (
                <GroupBlock key={label} label={label} count={items.length} sumTtc={sumTtc} sumKwh={sumKwh}
                  collapsed={isCollapsed} onToggle={() => toggleGroup(label)} eur={eur} kwhFmt={kwhFmt}>
                  {!isCollapsed && items.map((d) => <Row key={d.id} d={d} />)}
                </GroupBlock>
              );
            })}

            {rows.length === 0 && <tr><td colSpan={7} className="px-4 py-10 text-center text-[var(--kn-text-muted)]">Aucune facture ne correspond.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GroupBlock({ label, count, sumTtc, sumKwh, collapsed, onToggle, children, eur, kwhFmt }: {
  label: string; count: number; sumTtc: number; sumKwh: number; collapsed: boolean; onToggle: () => void;
  children: React.ReactNode; eur: (n: number) => string; kwhFmt: (n: number) => string;
}) {
  return (
    <>
      <tr className="cursor-pointer border-b border-[var(--kn-border)] bg-[var(--kn-panel)] hover:bg-[var(--kn-active)]" onClick={onToggle}>
        <td colSpan={5} className="px-4 py-2">
          <span className="flex items-center gap-1.5 font-semibold text-[#1a1a1a]">
            <ChevronRight className={cx("size-4 transition-transform", !collapsed && "rotate-90")} />
            {label}
            <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-[var(--kn-text-muted)]">{count}</span>
          </span>
        </td>
        <td className="px-4 py-2 text-right text-[12px] tabular-nums text-[var(--kn-text-muted)]">{sumKwh > 0 ? kwhFmt(sumKwh) : "—"}</td>
        <td className="px-4 py-2 text-right text-[13px] font-semibold tabular-nums text-[#1a1a1a]">{eur(sumTtc)}</td>
      </tr>
      {children}
    </>
  );
}
