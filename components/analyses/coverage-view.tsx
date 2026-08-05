"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { MapPin, Building2, Info, X, ExternalLink, AlertTriangle } from "lucide-react";
import type { CoverageData, CoverageInvoice } from "@/lib/data/coverage";

type Mode = "site" | "commune";
type Gran = "trimester" | "semester" | "year";

interface Col { key: string; label: string; start: string; end: string }

const GRANS: { id: Gran; label: string }[] = [
  { id: "trimester", label: "Trimestre" },
  { id: "semester", label: "Semestre" },
  { id: "year", label: "Année" },
];

function buildCols(minYear: number, maxYear: number, gran: Gran): Col[] {
  const cols: Col[] = [];
  for (let y = minYear; y <= maxYear; y++) {
    if (gran === "year") cols.push({ key: `${y}`, label: `${y}`, start: `${y}-01-01`, end: `${y}-12-31` });
    else if (gran === "semester") {
      cols.push({ key: `${y}-S1`, label: `S1 ${y}`, start: `${y}-01-01`, end: `${y}-06-30` });
      cols.push({ key: `${y}-S2`, label: `S2 ${y}`, start: `${y}-07-01`, end: `${y}-12-31` });
    } else {
      cols.push({ key: `${y}-T1`, label: `T1 ${y}`, start: `${y}-01-01`, end: `${y}-03-31` });
      cols.push({ key: `${y}-T2`, label: `T2 ${y}`, start: `${y}-04-01`, end: `${y}-06-30` });
      cols.push({ key: `${y}-T3`, label: `T3 ${y}`, start: `${y}-07-01`, end: `${y}-09-30` });
      cols.push({ key: `${y}-T4`, label: `T4 ${y}`, start: `${y}-10-01`, end: `${y}-12-31` });
    }
  }
  return cols;
}

const overlaps = (inv: CoverageInvoice, c: Col) => inv.spanStart <= c.end && inv.spanEnd >= c.start;
const eur = (n: number) => Math.round(n).toLocaleString("fr-FR") + " €";
const frDate = (d: string) => { const [y, m, j] = d.split("-"); return `${j}/${m}/${y}`; };

function cellStyle(n: number, max: number): { background: string; color: string } {
  if (n <= 0) return { background: "var(--kn-panel)", color: "transparent" };
  const t = max <= 1 ? 1 : n / max;
  if (t <= 0.34) return { background: "#fed7aa", color: "#9a3412" };
  if (t <= 0.67) return { background: "#fb923c", color: "#fff" };
  return { background: "#ea580c", color: "#fff" };
}

export function CoverageView({ data }: { data: CoverageData }) {
  const [mode, setMode] = useState<Mode>("site");
  const [gran, setGran] = useState<Gran>("semester");
  const [communeId, setCommuneId] = useState<string>(data.communes[0]?.id ?? "");
  const [sel, setSel] = useState<{ rowId: string; rowLabel: string; col: Col } | null>(null);

  const seg = (on: boolean) => `rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${on ? "bg-[var(--kn-solid)] text-white" : "text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)]"}`;

  // Périmètre : factures + lignes selon le mode.
  const scope = useMemo(() => {
    const invoices = mode === "site" ? data.invoices.filter((i) => i.communeId === communeId) : data.invoices;
    const rows = mode === "site"
      ? data.sites.filter((s) => s.communeId === communeId).map((s) => ({ id: s.id, label: s.nom }))
      : data.communes.map((c) => ({ id: c.id, label: c.nom }));
    return { invoices, rows };
  }, [mode, communeId, data]);

  const cols = useMemo(() => {
    if (scope.invoices.length === 0) return [];
    let minY = 9999, maxY = 0;
    for (const i of scope.invoices) {
      minY = Math.min(minY, +i.spanStart.slice(0, 4));
      maxY = Math.max(maxY, +i.spanEnd.slice(0, 4));
    }
    return buildCols(minY, maxY, gran);
  }, [scope.invoices, gran]);

  // Comptage par (row, col).
  const { counts, max } = useMemo(() => {
    const counts = new Map<string, number>();
    let max = 0;
    for (const row of scope.rows) {
      const rowInv = scope.invoices.filter((i) => (mode === "site" ? i.siteId : i.communeId) === row.id);
      for (const c of cols) {
        const n = rowInv.filter((i) => overlaps(i, c)).length;
        if (n > 0) counts.set(`${row.id}|${c.key}`, n);
        if (n > max) max = n;
      }
    }
    return { counts, max };
  }, [scope, cols, mode]);

  const selInvoices = useMemo(() => {
    if (!sel) return [];
    return scope.invoices
      .filter((i) => (mode === "site" ? i.siteId : i.communeId) === sel.rowId && overlaps(i, sel.col))
      .sort((a, b) => a.spanStart.localeCompare(b.spanStart));
  }, [sel, scope, mode]);

  return (
    <div className="mx-auto max-w-6xl px-8 py-6">
      <div className="mb-1 flex items-center gap-2.5">
        <LayoutGridIcon />
        <h1 className="font-heading text-2xl font-bold text-[var(--kn-text)]">Analyse de couverture</h1>
      </div>
      <p className="mb-4 text-[13px] text-[var(--kn-text-muted)]">
        Quelles périodes sont facturées, et lesquelles manquent — par site ou par commune. Une facture couvre toutes les périodes de sa plage de facturation.
      </p>

      {data.isDemo && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-[#fed7aa] bg-[var(--kn-yellow-soft)] px-3 py-2 text-[12px] text-[#9a3412]">
          <AlertTriangle className="size-4 shrink-0" /> Données de démonstration — les vraies s&apos;affichent une fois connecté.
        </div>
      )}

      {/* Contrôles */}
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-panel)] p-3">
        <div className="flex items-center gap-0.5 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] p-1">
          <button onClick={() => { setMode("site"); setSel(null); }} className={seg(mode === "site")}><MapPin className="mr-1 inline size-3.5" />Par site</button>
          <button onClick={() => { setMode("commune"); setSel(null); }} className={seg(mode === "commune")}><Building2 className="mr-1 inline size-3.5" />Par commune</button>
        </div>

        {mode === "site" && (
          <select value={communeId} onChange={(e) => { setCommuneId(e.target.value); setSel(null); }}
            className="h-9 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2.5 text-[13px] text-[var(--kn-text)] focus:border-[var(--kn-text)] focus:outline-none">
            {data.communes.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
          </select>
        )}

        <div className="flex items-center gap-0.5 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] p-1">
          {GRANS.map((g) => <button key={g.id} onClick={() => { setGran(g.id); setSel(null); }} className={seg(gran === g.id)}>{g.label}</button>)}
        </div>

        <span className="ml-auto text-[12px] text-[var(--kn-text-muted)]">
          <b className="text-[var(--kn-text)]">{scope.invoices.length}</b> facture{scope.invoices.length > 1 ? "s" : ""} · {cols.length} période{cols.length > 1 ? "s" : ""} × {scope.rows.length} {mode === "site" ? "site" : "commune"}{scope.rows.length > 1 ? "s" : ""}
        </span>
      </div>

      {/* Légende / aide */}
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-3 py-2 text-[12px] text-[var(--kn-text-muted)]">
        <span className="inline-flex items-center gap-1.5"><Info className="size-3.5" /> Chaque case = une période × une {mode === "site" ? "site" : "commune"}.</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-3 rounded-sm" style={{ background: "var(--kn-panel)", border: "1px solid var(--kn-border)" }} /> trou (non facturé)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-3 rounded-sm" style={{ background: "#fed7aa" }} />
          <span className="inline-block size-3 rounded-sm" style={{ background: "#fb923c" }} />
          <span className="inline-block size-3 rounded-sm" style={{ background: "#ea580c" }} /> nb de factures (croissant)
        </span>
        <span>Cliquez une case pour voir les factures.</span>
      </div>

      {/* Heatmap */}
      {scope.rows.length === 0 || cols.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--kn-border)] px-4 py-12 text-center text-sm text-[var(--kn-text-muted)]">
          Aucune donnée de couverture pour ce périmètre.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)]">
          <table className="border-separate border-spacing-0 text-[12px]">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-[var(--kn-card)] px-3 py-2 text-left font-medium text-[var(--kn-text-muted)]">{mode === "site" ? "Site" : "Commune"}</th>
                {cols.map((c) => (
                  <th key={c.key} className="px-1 py-2 text-center font-medium text-[var(--kn-text-muted)]" style={{ minWidth: 44 }}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scope.rows.map((row) => (
                <tr key={row.id}>
                  <td className="sticky left-0 z-10 max-w-[220px] truncate border-t border-[var(--kn-border)] bg-[var(--kn-card)] px-3 py-1.5 text-[var(--kn-text)]" title={row.label}>{row.label}</td>
                  {cols.map((c) => {
                    const n = counts.get(`${row.id}|${c.key}`) ?? 0;
                    const st = cellStyle(n, max);
                    const active = sel?.rowId === row.id && sel?.col.key === c.key;
                    return (
                      <td key={c.key} className="border-t border-[var(--kn-border)] p-0.5">
                        <button
                          onClick={() => setSel(n > 0 ? { rowId: row.id, rowLabel: row.label, col: c } : null)}
                          title={`${row.label} · ${c.label} · ${n} facture${n > 1 ? "s" : ""}`}
                          className={`flex h-7 w-full items-center justify-center rounded-[4px] text-[11px] font-semibold tabular-nums transition-transform ${n > 0 ? "cursor-pointer hover:scale-110" : "cursor-default"} ${active ? "ring-2 ring-[#0f172a] ring-offset-1" : ""}`}
                          style={{ background: st.background, color: st.color }}
                        >
                          {n > 0 ? n : ""}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Volet latéral : factures de la case sélectionnée */}
      {sel && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setSel(null)} />
          <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-[var(--kn-border)] bg-[var(--kn-card)] shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-[var(--kn-border)] p-4">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--kn-text-muted)]">{sel.col.label}</p>
                <h3 className="font-heading text-[15px] font-bold text-[var(--kn-text)]">{sel.rowLabel}</h3>
                <p className="text-[12px] text-[var(--kn-text-muted)]">{selInvoices.length} facture{selInvoices.length > 1 ? "s" : ""} sur cette période</p>
              </div>
              <button onClick={() => setSel(null)} className="rounded-md p-1.5 text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]"><X className="size-4" /></button>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
              {selInvoices.map((i) => (
                <Link key={i.id} href={`/documents/extraction?id=${i.id}`}
                  className="block rounded-lg border border-[var(--kn-border)] bg-[var(--kn-panel)] p-3 transition-colors hover:border-[#f97316]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-[var(--kn-text)]">{i.factureNumber}</span>
                    <span className="inline-flex items-center gap-1 text-[12px] font-medium text-[#f97316]">Ouvrir <ExternalLink className="size-3.5" /></span>
                  </div>
                  <p className="mt-1 text-[12px] text-[var(--kn-text-muted)]">
                    Période {frDate(i.spanStart)} → {frDate(i.spanEnd)} · {eur(i.totalTtc)}
                  </p>
                  {mode === "commune" && <p className="text-[12px] text-[var(--kn-text-muted)]">Site : {i.siteNom}</p>}
                </Link>
              ))}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}

function LayoutGridIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-6 text-[var(--kn-text)]" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}
