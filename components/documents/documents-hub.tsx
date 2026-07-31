"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Search, Download, Building2, Lightbulb, ChevronsUpDown, ChevronUp, ChevronDown,
  List, LayoutGrid, Columns3, FileText, Loader2,
  Check, Eye, EyeOff, Zap, Euro, CalendarRange, Hash, AlertTriangle, X,
} from "lucide-react";
import type { InvoiceDoc, InvoiceListPage } from "@/lib/data/invoices";
import type { SortKey } from "@/lib/data/invoice-list-params";
import { SelectionBar } from "./selection-bar";
import { DocumentCard } from "./document-card";
import { ColumnsView } from "./columns-view";
import { ConfidenceBadge } from "./confidence-badge";
import { AnomalyTicker } from "./anomaly-ticker";
import { PaginationBar } from "./pagination-bar";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");
const eurShort = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 0 }) + " €";
const kwhFmt = (n: number) => n.toLocaleString("fr-FR") + " kWh";
const catLabel = (c: string) => (c === "batiment" ? "Bâtiment" : "Éclairage public");
const frDate = (d: string) => { const [y, m, j] = d.split("-"); return `${j}/${m}/${y}`; };

type CatFilter = "" | "batiment" | "eclairage_public";
type View = "liste" | "galerie" | "colonnes";

const VIEWS: { id: View; label: string; icon: typeof List }[] = [
  { id: "liste", label: "Liste", icon: List },
  { id: "galerie", label: "Galerie", icon: LayoutGrid },
  { id: "colonnes", label: "Colonnes", icon: Columns3 },
];

interface Commune { id: string; nom: string }
interface Site { id: string; nom: string; commune_id: string | null }

export interface HubFilters {
  query?: string;
  categorie?: "batiment" | "eclairage_public";
  communeId?: string;
  siteId?: string;
  onlyAnomalies?: boolean;
  showArchived?: boolean;
  sort: SortKey;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
}

export function DocumentsHub({
  result, communes, sites, filters,
}: {
  result: InvoiceListPage;
  communes: Commune[];
  sites: Site[];
  filters: HubFilters;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const [view, setView] = useState<View>("liste");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Miroir local du champ recherche : l'URL est la source de vérité mais on ne peut pas
  // attendre l'aller-retour serveur à chaque frappe (perte de focus + requête inutile).
  const [queryDraft, setQueryDraft] = useState(filters.query ?? "");

  const { docs, kpis, page, pageSize, pageCount, isDemo } = result;

  /** Écrit les filtres dans l'URL — état partageable, bouton retour fonctionnel. */
  function setParams(next: Record<string, string | number | boolean | undefined>, resetPage = true) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === "" || v === false) params.delete(k);
      else params.set(k, v === true ? "1" : String(v));
    }
    if (resetPage) params.delete("page"); // un filtre modifié invalide la page courante
    startTransition(() => router.push(`/documents${params.toString() ? "?" + params : ""}`, { scroll: false }));
  }

  // Recherche : on ne pousse dans l'URL qu'après une pause de frappe.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    const id = setTimeout(() => {
      if (queryDraft !== (filters.query ?? "")) setParams({ q: queryDraft || undefined });
    }, 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryDraft]);

  // Changer de page/filtre remplace le contenu : une sélection portant sur des lignes
  // qui ne sont plus affichées serait invisible et dangereuse (actions en masse).
  useEffect(() => { setSelected(new Set()); }, [page, filters.query, filters.categorie, filters.communeId, filters.siteId, filters.onlyAnomalies, filters.showArchived]);

  const sitesForCommune = useMemo(
    () => (filters.communeId ? sites.filter((s) => s.commune_id === filters.communeId) : sites),
    [sites, filters.communeId],
  );

  const toggleSort = (key: SortKey) =>
    setParams({ sort: key, dir: filters.sort === key && filters.dir === "desc" ? "asc" : "desc" }, false);

  const toggleSel = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const setMany = (ids: string[], on: boolean) => setSelected((s) => { const n = new Set(s); ids.forEach((id) => (on ? n.add(id) : n.delete(id))); return n; });
  const clearSel = () => setSelected(new Set());

  const pageIds = docs.map((d) => d.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const selectedDocs = useMemo(() => docs.filter((d) => selected.has(d.id)), [docs, selected]);

  const hasFilters = !!(filters.query || filters.categorie || filters.communeId || filters.siteId || filters.onlyAnomalies || filters.showArchived);

  /** L'export porte sur tout le périmètre filtré, pas sur la page affichée. */
  function exportCsv() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("page");
    params.delete("size");
    window.location.href = `/api/export/invoices${params.toString() ? "?" + params : ""}`;
  }

  const SortBtn = ({ k, label, align }: { k: SortKey; label: string; align?: "right" }) => (
    <button onClick={() => toggleSort(k)}
      className={cx("inline-flex cursor-pointer items-center gap-1 hover:text-[var(--kn-text)]", align === "right" && "flex-row-reverse")}>
      {label}
      {filters.sort === k
        ? (filters.dir === "asc" ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />)
        : <ChevronsUpDown className="size-3 opacity-40" />}
    </button>
  );

  const Tick = ({ on, onClick }: { on: boolean; onClick: (e: React.MouseEvent) => void }) => (
    <button onClick={onClick} aria-label={on ? "Désélectionner" : "Sélectionner"}
      className={cx("flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border transition-colors",
        on ? "border-[#f97316] bg-[#f97316] text-white" : "border-[var(--kn-border)] text-transparent hover:border-[#f97316]")}>
      <Check className="size-3" strokeWidth={3} />
    </button>
  );

  const Row = ({ d }: { d: InvoiceDoc }) => (
    <tr className={cx("border-b border-[var(--kn-border)] last:border-0 hover:bg-[var(--kn-yellow-soft)]", selected.has(d.id) && "bg-[var(--kn-yellow-soft)]", d.archived && "opacity-60")}>
      <td className="px-3 py-2.5"><Tick on={selected.has(d.id)} onClick={() => toggleSel(d.id)} /></td>
      <td className="px-4 py-0">
        <div className="flex items-center gap-2 py-2.5">
          <Link href={`/documents/extraction?id=${d.id}`} className="font-medium text-[var(--kn-text)]">{d.number}</Link>
          <AnomalyTicker invoiceId={d.id} anomalies={d.anomalies} label={false} />
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
      <td className="px-4 py-2.5 text-right font-medium tabular-nums">{eurShort(d.totalTtc)}</td>
    </tr>
  );

  return (
    <div className="flex h-full flex-col">
      {/* En-tête : KPIs + barre d'outils */}
      <div className="shrink-0 px-8 pb-3 pt-5">
        {/* KPIs — calculés en SQL sur tout le périmètre filtré, pas sur la page affichée */}
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi icon={<Hash className="size-4" />} label="Factures" value={kpis.count.toLocaleString("fr-FR")} />
          <Kpi icon={<Euro className="size-4" />} label="Total TTC" value={eurShort(kpis.totalTtc)} />
          <Kpi icon={<Zap className="size-4" />} label="Consommation" value={kwhFmt(kpis.totalKwh)} />
          <Kpi icon={<CalendarRange className="size-4" />} label="Période" value={kpis.periode} />
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {isDemo && <span className="rounded-full bg-[var(--kn-yellow-soft)] px-2 py-0.5 text-[11px] font-medium text-[#9a3412]">Aperçu — vraies données une fois connecté</span>}

          <div className="flex items-center gap-0.5 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] p-0.5">
            {VIEWS.map((v) => (
              <button key={v.id} onClick={() => setView(v.id)} title={v.label}
                className={cx("flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors",
                  view === v.id ? "bg-[#f97316] text-white" : "text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)]")}>
                <v.icon className="size-3.5" /> <span className="hidden sm:inline">{v.label}</span>
              </button>
            ))}
          </div>

          <div className="relative min-w-[200px] max-w-xs flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--kn-text-muted)]" strokeWidth={1.75} />
            <input value={queryDraft} onChange={(e) => setQueryDraft(e.target.value)}
              placeholder="Rechercher (n°, site, commune)"
              className="h-9 w-full rounded-lg border border-[var(--kn-border)] pl-9 pr-8 text-sm focus:border-[#f97316] focus:outline-none" />
            {queryDraft && (
              <button onClick={() => setQueryDraft("")} aria-label="Effacer la recherche"
                className="absolute right-2 top-1/2 flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-[var(--kn-text-muted)] hover:text-[var(--kn-text)]">
                <X className="size-3.5" />
              </button>
            )}
          </div>

          <FilterSelect label="Commune" value={filters.communeId ?? ""}
            onChange={(v) => setParams({ commune: v || undefined, site: undefined })}
            options={[{ value: "", label: "Toutes les communes" }, ...communes.map((c) => ({ value: c.id, label: c.nom }))]} />

          <FilterSelect label="Site" value={filters.siteId ?? ""}
            onChange={(v) => setParams({ site: v || undefined })}
            options={[{ value: "", label: "Tous les sites" }, ...sitesForCommune.map((s) => ({ value: s.id, label: s.nom }))]} />

          <div className="flex items-center gap-1 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] p-1 text-[13px]">
            {([["", "Toutes"], ["batiment", "Bâtiments"], ["eclairage_public", "Éclairage"]] as [CatFilter, string][]).map(([v, label]) => (
              <button key={v || "all"} onClick={() => setParams({ cat: v || undefined })}
                className={cx("cursor-pointer rounded-md px-2.5 py-1 font-medium transition-colors",
                  (filters.categorie ?? "") === v ? "bg-[var(--kn-solid)] text-white" : "text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)]")}>
                {label}
              </button>
            ))}
          </div>

          {kpis.anomalyCount > 0 && (
            <button onClick={() => setParams({ anomalies: !filters.onlyAnomalies })} title="Factures avec anomalie ouverte"
              className={cx("flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px] font-medium transition-colors",
                filters.onlyAnomalies ? "border-[#f59e0b] bg-[#f59e0b]/10 text-[#b45309]" : "border-[var(--kn-border)] text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)]")}>
              <AlertTriangle className="size-3.5 text-[#f59e0b]" /> Anomalies ({kpis.anomalyCount})
            </button>
          )}

          {kpis.archivedCount > 0 && (
            <button onClick={() => setParams({ archived: !filters.showArchived })}
              className={cx("flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px] font-medium transition-colors",
                filters.showArchived ? "border-[#f97316] bg-[var(--kn-yellow-soft)] text-[#9a3412]" : "border-[var(--kn-border)] text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)]")}>
              {filters.showArchived ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />} Masqués ({kpis.archivedCount})
            </button>
          )}

          {hasFilters && (
            <button onClick={() => startTransition(() => router.push("/documents", { scroll: false }))}
              className="cursor-pointer rounded-lg px-2 py-1.5 text-[12px] font-medium text-[var(--kn-text-muted)] underline-offset-2 hover:text-[var(--kn-text)] hover:underline">
              Réinitialiser
            </button>
          )}

          <button onClick={exportCsv} title="Exporte l'ensemble du périmètre filtré, pas seulement la page affichée"
            className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--kn-solid)] px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:opacity-90">
            <Download className="size-3.5" /> Exporter CSV
          </button>
        </div>
      </div>

      {/* Contenu */}
      <div className={cx("relative min-h-0 flex-1 px-8", view === "colonnes" ? "overflow-hidden" : "overflow-y-auto", pending && "opacity-60")}>
        {pending && (
          <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
            <span className="flex items-center gap-2 rounded-full border border-[var(--kn-border)] bg-[var(--kn-card)] px-3 py-1.5 text-[12px] text-[var(--kn-text-muted)] shadow-sm">
              <Loader2 className="size-3.5 animate-spin text-[#f97316]" /> Chargement…
            </span>
          </div>
        )}

        {docs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--kn-text-muted)]">
            <FileText className="size-8" strokeWidth={1.4} />
            <p className="text-[13px]">{hasFilters ? "Aucune facture ne correspond à ces filtres." : "Aucune facture pour le moment."}</p>
            {hasFilters && (
              <button onClick={() => startTransition(() => router.push("/documents", { scroll: false }))}
                className="cursor-pointer text-[13px] font-medium text-[#ea580c] underline underline-offset-2">
                Réinitialiser les filtres
              </button>
            )}
          </div>
        ) : view === "liste" ? (
          <div className="overflow-x-auto rounded-xl border border-[var(--kn-border)]">
            <table className="w-full min-w-[900px] text-[13px]">
              <thead>
                <tr className="border-b border-[var(--kn-border)] bg-[var(--kn-panel)] text-left text-[var(--kn-text-muted)]">
                  <th className="px-3 py-2.5"><Tick on={allSelected} onClick={() => setMany(pageIds, !allSelected)} /></th>
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
              <tbody>{docs.map((d) => <Row key={d.id} d={d} />)}</tbody>
            </table>
          </div>
        ) : view === "colonnes" ? (
          <ColumnsView docs={docs} selected={selected} onToggle={toggleSel} />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {docs.map((d) => <DocumentCard key={d.id} doc={d} selected={selected.has(d.id)} onToggle={() => toggleSel(d.id)} />)}
          </div>
        )}
      </div>

      <div className="shrink-0">
        <PaginationBar
          page={page} pageCount={pageCount} pageSize={pageSize} total={kpis.count} pending={pending}
          onPage={(p) => setParams({ page: p }, false)}
          onPageSize={(s) => setParams({ size: s })}
        />
      </div>

      {selected.size > 0 && <SelectionBar selectedDocs={selectedDocs} onClear={clearSel} />}
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}
      className="h-9 max-w-[190px] cursor-pointer rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2.5 text-[13px] text-[var(--kn-text)] focus:border-[#f97316] focus:outline-none">
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
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
