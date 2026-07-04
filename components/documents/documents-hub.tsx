"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Search, Download, Building2, Lightbulb, ChevronsUpDown, ChevronUp, ChevronDown,
  ChevronRight, Layers, List, LayoutGrid, Columns3, FileText,
  Check, Eye, EyeOff, Zap, Euro, CalendarRange, Hash, AlertTriangle,
} from "lucide-react";
import type { InvoiceDoc } from "@/lib/data/invoices";
import { downloadCsv } from "@/lib/csv";
import { loadResolved, anomalyKey } from "@/lib/data/anomalies";
import { SelectionBar } from "./selection-bar";
import { DocumentCard } from "./document-card";
import { ColumnsView } from "./columns-view";
import { ConfidenceBadge } from "./confidence-badge";
import { AnomalyTicker } from "./anomaly-ticker";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");
const eur = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const eurShort = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 0 }) + " €";
const kwhFmt = (n: number) => n.toLocaleString("fr-FR") + " kWh";
const catLabel = (c: string) => (c === "batiment" ? "Bâtiment" : "Éclairage public");
const frDate = (d: string) => { const [y, m, j] = d.split("-"); return `${j}/${m}/${y}`; };

type SortKey = "date" | "number" | "site" | "commune" | "kwh" | "totalTtc";
type CatFilter = "all" | "batiment" | "eclairage_public";
type GroupBy = "none" | "commune" | "site" | "categorie";
type View = "liste" | "galerie" | "colonnes";

const VIEWS: { id: View; label: string; icon: typeof List }[] = [
  { id: "liste", label: "Liste", icon: List },
  { id: "galerie", label: "Galerie", icon: LayoutGrid },
  { id: "colonnes", label: "Colonnes", icon: Columns3 },
];

export function DocumentsHub({ docs, isDemo }: { docs: InvoiceDoc[]; isDemo?: boolean }) {
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<CatFilter>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "date", dir: -1 });
  const [groupBy, setGroupBy] = useState<GroupBy>("commune");
  const [view, setView] = useState<View>("liste");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [onlyAnomalies, setOnlyAnomalies] = useState(false);
  const [resolved, setResolved] = useState<Set<string>>(new Set());

  useEffect(() => { setResolved(loadResolved()); }, []);

  const openAnoms = (d: InvoiceDoc) => (d.anomalies ?? []).filter((a) => !resolved.has(anomalyKey(d.id, a.type)));
  const hasAnomaly = (d: InvoiceDoc) => openAnoms(d).length > 0;

  const archivedCount = useMemo(() => docs.filter((d) => d.archived).length, [docs]);
  const anomalyCount = useMemo(() => docs.filter((d) => !d.archived && hasAnomaly(d)).length, [docs, resolved]);

  const rows = useMemo(() => {
    const q = query.toLowerCase();
    const list = docs.filter(
      (d) => (showArchived ? true : !d.archived) &&
        (cat === "all" || d.categorie === cat) &&
        (!onlyAnomalies || hasAnomaly(d)) &&
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
  }, [docs, query, cat, sort, showArchived, onlyAnomalies, resolved]);

  const groupKey = (d: InvoiceDoc) => (groupBy === "commune" ? d.commune : groupBy === "site" ? d.site : catLabel(d.categorie));
  const groups = useMemo(() => {
    if (groupBy === "none") return null;
    const map = new Map<string, InvoiceDoc[]>();
    for (const d of rows) { const k = groupKey(d); (map.get(k) ?? map.set(k, []).get(k)!).push(d); }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows, groupBy]);

  // KPIs (sur le périmètre filtré)
  const kpis = useMemo(() => {
    const totalTtc = rows.reduce((s, d) => s + d.totalTtc, 0);
    const totalKwh = rows.reduce((s, d) => s + d.kwh, 0);
    const years = rows.map((d) => Number(d.date.slice(0, 4))).filter((y) => !Number.isNaN(y));
    const min = years.length ? Math.min(...years) : null;
    const max = years.length ? Math.max(...years) : null;
    return { count: rows.length, totalTtc, totalKwh, periode: min ? (min === max ? `${min}` : `${min}–${max}`) : "—" };
  }, [rows]);

  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  const toggleGroup = (k: string) => setCollapsed((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const toggleSel = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const setMany = (ids: string[], on: boolean) => setSelected((s) => { const n = new Set(s); ids.forEach((id) => (on ? n.add(id) : n.delete(id))); return n; });
  const clearSel = () => setSelected(new Set());

  const allVisibleIds = rows.map((d) => d.id);
  const allSelected = allVisibleIds.length > 0 && allVisibleIds.every((id) => selected.has(id));
  const selectedDocs = useMemo(() => docs.filter((d) => selected.has(d.id)), [docs, selected]);

  function exportCsv() {
    const headers = ["N° facture", "Date", "Site", "Commune", "Catégorie", "Duplicata", "Total HT (€)", "TVA (€)", "Total TTC (€)", "Conso (kWh)"];
    const data: (string | number | null)[][] = [headers];
    const rowOf = (d: InvoiceDoc) => [d.number, frDate(d.date), d.site, d.commune, catLabel(d.categorie), d.isDuplicata ? "Oui" : "Non", d.totalHt, d.tva, d.totalTtc, d.kwh];
    if (groups) {
      for (const [label, items] of groups) {
        data.push([`▸ ${label} (${items.length})`]);
        items.forEach((d) => data.push(rowOf(d)));
        data.push(["", "", "", "", "", `Sous-total ${label}`, items.reduce((s, d) => s + d.totalHt, 0), items.reduce((s, d) => s + d.tva, 0), items.reduce((s, d) => s + d.totalTtc, 0), items.reduce((s, d) => s + d.kwh, 0)]);
      }
    } else {
      rows.forEach((d) => data.push(rowOf(d)));
    }
    downloadCsv("mes-documents.csv", data);
  }

  const SortBtn = ({ k, label, align }: { k: SortKey; label: string; align?: "right" }) => (
    <button onClick={() => toggleSort(k)} className={cx("inline-flex items-center gap-1 hover:text-[var(--kn-text)]", align === "right" && "flex-row-reverse")}>
      {label}
      {sort.key === k ? (sort.dir === 1 ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />) : <ChevronsUpDown className="size-3 opacity-40" />}
    </button>
  );

  const Tick = ({ on, onClick }: { on: boolean; onClick: (e: React.MouseEvent) => void }) => (
    <button onClick={onClick} aria-label={on ? "Désélectionner" : "Sélectionner"}
      className={cx("flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
        on ? "border-[#f97316] bg-[#f97316] text-white" : "border-[var(--kn-border)] text-transparent hover:border-[#f97316]")}>
      <Check className="size-3" strokeWidth={3} />
    </button>
  );

  const Row = ({ d }: { d: InvoiceDoc }) => (
    <tr className={cx("border-b border-[var(--kn-border)] last:border-0 hover:bg-[var(--kn-yellow-soft)]", selected.has(d.id) && "bg-[var(--kn-yellow-soft)]", d.archived && "opacity-60")}>
      <td className="px-3 py-2.5"><Tick on={selected.has(d.id)} onClick={() => toggleSel(d.id)} /></td>
      <td className="px-4 py-0">
        <div className="flex items-center gap-2 py-2.5">
          <Link href={`/documents/extraction?id=${d.id}`} className="font-medium text-[var(--kn-text)]">
            {d.number}
          </Link>
          <AnomalyTicker invoiceId={d.id} anomalies={d.anomalies} />
          {d.archived && <span className="rounded bg-[var(--kn-value-box)] px-1.5 text-[10px] text-[var(--kn-text-muted)]">masqué</span>}
        </div>
      </td>
      <td className="px-4 py-2.5 text-[var(--kn-text-muted)]">{frDate(d.date)}</td>
      <td className="px-4 py-2.5">{d.site}</td>
      <td className="px-4 py-2.5 text-[var(--kn-text-muted)]">{d.commune}</td>
      <td className="px-4 py-2.5">
        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--kn-value-box)] px-2 py-0.5 text-[11px] text-[var(--kn-text-muted)]">
          {d.categorie === "batiment" ? <Building2 className="size-3" /> : <Lightbulb className="size-3" />}{catLabel(d.categorie)}
        </span>
      </td>
      <td className="px-4 py-2.5"><ConfidenceBadge value={d.confidence} /></td>
      <td className="px-4 py-2.5 text-right tabular-nums text-[var(--kn-text-muted)]">{d.kwh > 0 ? kwhFmt(d.kwh) : "—"}</td>
      <td className="px-4 py-2.5 text-right font-medium tabular-nums">{eur(d.totalTtc)}</td>
    </tr>
  );

  const GroupHeaderRow = ({ label, items }: { label: string; items: InvoiceDoc[] }) => {
    const ids = items.map((i) => i.id);
    const allOn = ids.every((id) => selected.has(id));
    const isCollapsed = collapsed.has(label);
    return (
      <tr className="border-b border-[var(--kn-border)] bg-[var(--kn-panel)]">
        <td className="px-3 py-2"><Tick on={allOn} onClick={(e) => { e.stopPropagation(); setMany(ids, !allOn); }} /></td>
        <td colSpan={6} className="cursor-pointer px-4 py-2" onClick={() => toggleGroup(label)}>
          <span className="flex items-center gap-1.5 font-semibold text-[var(--kn-text)]">
            <ChevronRight className={cx("size-4 transition-transform", !isCollapsed && "rotate-90")} />
            {label}
            <span className="rounded-full bg-[var(--kn-card)] px-2 py-0.5 text-[11px] font-medium text-[var(--kn-text-muted)]">{items.length}</span>
          </span>
        </td>
        <td className="px-4 py-2 text-right text-[12px] tabular-nums text-[var(--kn-text-muted)]">{items.reduce((s, d) => s + d.kwh, 0) > 0 ? kwhFmt(items.reduce((s, d) => s + d.kwh, 0)) : "—"}</td>
        <td className="px-4 py-2 text-right text-[13px] font-semibold tabular-nums text-[var(--kn-text)]">{eur(items.reduce((s, d) => s + d.totalTtc, 0))}</td>
      </tr>
    );
  };

  // Galerie / icônes : segments [label|null, items]
  const segments: [string | null, InvoiceDoc[]][] = groups ? groups.map(([l, i]) => [l, i]) : [[null, rows]];

  const GalleryGrid = ({ items }: { items: InvoiceDoc[] }) => (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {items.map((d) => <DocumentCard key={d.id} doc={d} selected={selected.has(d.id)} onToggle={() => toggleSel(d.id)} />)}
    </div>
  );

  const GroupBanner = ({ label, items }: { label: string; items: InvoiceDoc[] }) => {
    const ids = items.map((i) => i.id);
    const allOn = ids.every((id) => selected.has(id));
    return (
      <div className="mb-2 mt-1 flex items-center gap-2">
        <Tick on={allOn} onClick={(e) => { e.stopPropagation(); setMany(ids, !allOn); }} />
        <h3 className="text-[13px] font-semibold text-[var(--kn-text)]">{label}</h3>
        <span className="rounded-full bg-[var(--kn-value-box)] px-2 py-0.5 text-[11px] text-[var(--kn-text-muted)]">{items.length}</span>
        <span className="ml-auto text-[12px] font-medium tabular-nums text-[var(--kn-text-muted)]">{eur(items.reduce((s, d) => s + d.totalTtc, 0))}</span>
      </div>
    );
  };

  const scroll = view === "colonnes" ? "overflow-hidden" : "overflow-y-auto";

  return (
    <div className="flex h-full flex-col">
      {/* En-tête : KPIs + barre d'outils */}
      <div className="shrink-0 px-8 pb-3 pt-5">
        {/* Bandeau KPI orange */}
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi icon={<Hash className="size-4" />} label="Factures" value={String(kpis.count)} />
          <Kpi icon={<Euro className="size-4" />} label="Total TTC" value={eurShort(kpis.totalTtc)} />
          <Kpi icon={<Zap className="size-4" />} label="Consommation" value={kwhFmt(kpis.totalKwh)} />
          <Kpi icon={<CalendarRange className="size-4" />} label="Période" value={kpis.periode} />
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {isDemo && <span className="rounded-full bg-[var(--kn-yellow-soft)] px-2 py-0.5 text-[11px] font-medium text-[#9a3412]">Aperçu — vraies données une fois connecté</span>}
          {/* Sélecteur de vue */}
          <div className="flex items-center gap-0.5 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] p-0.5">
            {VIEWS.map((v) => (
              <button key={v.id} onClick={() => setView(v.id)} title={v.label}
                className={cx("flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors",
                  view === v.id ? "bg-[#f97316] text-white" : "text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)]")}>
                <v.icon className="size-3.5" /> <span className="hidden sm:inline">{v.label}</span>
              </button>
            ))}
          </div>

          <div className="relative min-w-[200px] flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--kn-text-muted)]" strokeWidth={1.75} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher (n°, site, commune)"
              className="h-9 w-full rounded-lg border border-[var(--kn-border)] pl-9 pr-3 text-sm focus:border-[#f97316] focus:outline-none" />
          </div>

          <div className="flex items-center gap-1 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] p-1 text-[13px]">
            {([["all", "Toutes"], ["batiment", "Bâtiments"], ["eclairage_public", "Éclairage"]] as [CatFilter, string][]).map(([v, label]) => (
              <button key={v} onClick={() => setCat(v)} className={cx("rounded-md px-2.5 py-1 font-medium transition-colors", cat === v ? "bg-[var(--kn-solid)] text-white" : "text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)]")}>{label}</button>
            ))}
          </div>

          {anomalyCount > 0 && (
            <button onClick={() => setOnlyAnomalies((s) => !s)} title="Factures avec anomalie détectée"
              className={cx("flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px] font-medium transition-colors",
                onlyAnomalies ? "border-[#f59e0b] bg-[#f59e0b]/10 text-[#b45309]" : "border-[var(--kn-border)] text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)]")}>
              <AlertTriangle className="size-3.5 text-[#f59e0b]" /> Anomalies ({anomalyCount})
            </button>
          )}

          <div className="flex items-center gap-1.5 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2 py-1.5 text-[13px]">
            <Layers className="size-3.5 text-[var(--kn-text-muted)]" />
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)} className="bg-transparent font-medium text-[var(--kn-text)] focus:outline-none">
              <option value="none">Aucun regroupement</option>
              <option value="commune">Par commune</option>
              <option value="site">Par site</option>
              <option value="categorie">Par catégorie</option>
            </select>
          </div>

          {archivedCount > 0 && (
            <button onClick={() => setShowArchived((s) => !s)}
              className={cx("flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px] font-medium transition-colors",
                showArchived ? "border-[#f97316] bg-[var(--kn-yellow-soft)] text-[#9a3412]" : "border-[var(--kn-border)] text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)]")}>
              {showArchived ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />} Masqués ({archivedCount})
            </button>
          )}

          <button onClick={exportCsv} className="ml-auto flex items-center gap-1.5 rounded-lg bg-[var(--kn-solid)] px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:opacity-90">
            <Download className="size-3.5" /> Exporter CSV
          </button>
        </div>
      </div>

      {/* Contenu */}
      <div className={cx("min-h-0 flex-1 px-8 pb-24", scroll)}>
        {rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--kn-text-muted)]">
            <FileText className="size-8" strokeWidth={1.4} />
            <p className="text-[13px]">Aucune facture ne correspond.</p>
          </div>
        ) : view === "liste" ? (
          <div className="overflow-hidden rounded-xl border border-[var(--kn-border)]">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-[var(--kn-border)] bg-[var(--kn-panel)] text-left text-[var(--kn-text-muted)]">
                  <th className="px-3 py-2.5"><Tick on={allSelected} onClick={() => setMany(allVisibleIds, !allSelected)} /></th>
                  <th className="px-4 py-2.5 font-medium"><SortBtn k="number" label="N° facture" /></th>
                  <th className="px-4 py-2.5 font-medium"><SortBtn k="date" label="Date" /></th>
                  <th className="px-4 py-2.5 font-medium"><SortBtn k="site" label="Site" /></th>
                  <th className="px-4 py-2.5 font-medium"><SortBtn k="commune" label="Commune" /></th>
                  <th className="px-4 py-2.5 font-medium">Catégorie</th>
                  <th className="px-4 py-2.5 font-medium">Confiance</th>
                  <th className="px-4 py-2.5 text-right font-medium"><SortBtn k="kwh" label="Conso" align="right" /></th>
                  <th className="px-4 py-2.5 text-right font-medium"><SortBtn k="totalTtc" label="Total TTC" align="right" /></th>
                </tr>
              </thead>
              <tbody>
                {!groups && rows.map((d) => <Row key={d.id} d={d} />)}
                {groups && groups.map(([label, items]) => (
                  <GroupRows key={label} label={label} items={items} collapsed={collapsed.has(label)} Header={GroupHeaderRow} RowComp={Row} />
                ))}
              </tbody>
            </table>
          </div>
        ) : view === "colonnes" ? (
          <ColumnsView docs={rows} selected={selected} onToggle={toggleSel} />
        ) : (
          <div className="space-y-5">
            {segments.map(([label, items]) => (
              <section key={label ?? "_all"}>
                {label && <GroupBanner label={label} items={items} />}
                <GalleryGrid items={items} />
              </section>
            ))}
          </div>
        )}
      </div>

      {selected.size > 0 && <SelectionBar selectedDocs={selectedDocs} onClear={clearSel} />}
    </div>
  );
}

function GroupRows({ label, items, collapsed, Header, RowComp }: {
  label: string; items: InvoiceDoc[]; collapsed: boolean;
  Header: (p: { label: string; items: InvoiceDoc[] }) => React.JSX.Element;
  RowComp: (p: { d: InvoiceDoc }) => React.JSX.Element;
}) {
  return (
    <>
      <Header label={label} items={items} />
      {!collapsed && items.map((d) => <RowComp key={d.id} d={d} />)}
    </>
  );
}

function Kpi({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--kn-yellow-soft)] text-[#ea580c]">{icon}</span>
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--kn-text-muted)]">{label}</p>
        <p className="truncate text-[16px] font-bold tabular-nums text-[var(--kn-text)]">{value}</p>
      </div>
    </div>
  );
}
