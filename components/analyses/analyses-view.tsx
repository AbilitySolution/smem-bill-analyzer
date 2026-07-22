"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, Brush,
} from "recharts";
import { Gauge, Zap, Euro, FileText, AlertTriangle, Plug } from "lucide-react";
import type { AnalysisData, Metric, MonthBucket } from "@/lib/data/consumption";

interface Commune { id: string; nom: string }
interface Site { id: string; nom: string; commune_id: string | null; categorie: string }
interface Filters { commune: string; site: string; cat: string }

type Gran = "month" | "semester" | "year";
type PosteFilter = "all" | "base" | "hphc";

const C = { hp: "#ea580c", hc: "#fdba74", base: "#64748b", abo: "#cbd5e1", total: "#ea580c" };
const MO = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const GRANS: { id: Gran; label: string }[] = [
  { id: "month", label: "Mensuel" },
  { id: "semester", label: "Semestriel" },
  { id: "year", label: "Annuel" },
];
const POSTES: { id: PosteFilter; label: string }[] = [
  { id: "all", label: "Tous" },
  { id: "base", label: "Base" },
  { id: "hphc", label: "HP/HC" },
];
const nf = (n: number) => Math.round(n).toLocaleString("fr-FR");

interface Bucket { order: string; label: string; hpKwh: number; hcKwh: number; baseKwh: number; hpEur: number; hcEur: number; baseEur: number; aboEur: number }

/** Ré-agrège les buckets mensuels en mensuel / semestriel / annuel. */
function reBucket(months: MonthBucket[], gran: Gran): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const m of months) {
    const y = +m.key.slice(0, 4), mo = +m.key.slice(5, 7);
    let order: string, label: string;
    if (gran === "year") { order = `${y}`; label = `${y}`; }
    else if (gran === "semester") { const s = mo <= 6 ? 1 : 2; order = `${y}-${s}`; label = `S${s} ${y}`; }
    else { order = m.key; label = `${MO[mo - 1]} ${String(y).slice(2)}`; }
    let b = map.get(order);
    if (!b) { b = { order, label, hpKwh: 0, hcKwh: 0, baseKwh: 0, hpEur: 0, hcEur: 0, baseEur: 0, aboEur: 0 }; map.set(order, b); }
    b.hpKwh += m.hpKwh; b.hcKwh += m.hcKwh; b.baseKwh += m.baseKwh;
    b.hpEur += m.hpEur; b.hcEur += m.hcEur; b.baseEur += m.baseEur; b.aboEur += m.aboEur;
  }
  return [...map.values()].sort((a, b) => a.order.localeCompare(b.order));
}

export function AnalysesView({
  analysis, communes, sites, filters,
}: {
  analysis: AnalysisData;
  communes: Commune[];
  sites: Site[];
  filters: Filters;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [metric, setMetric] = useState<Metric>("eur");
  const [gran, setGran] = useState<Gran>("semester");
  const [poste, setPoste] = useState<PosteFilter>("all");
  const [curveMode, setCurveMode] = useState<"total" | "detail">("total");
  const unit = metric === "kwh" ? "kWh" : "€";
  const isEur = metric === "eur";

  function setFilter(next: Partial<Filters>) {
    const f = { ...filters, ...next };
    if (next.commune !== undefined) f.site = "";
    const params = new URLSearchParams();
    if (f.commune) params.set("commune", f.commune);
    if (f.site) params.set("site", f.site);
    if (f.cat) params.set("cat", f.cat);
    startTransition(() => router.push(`/analyses${params.toString() ? "?" + params : ""}`));
  }

  const buckets = useMemo(() => reBucket(analysis.months, gran), [analysis.months, gran]);

  // Courbe (gauche). Total = variable+abonnement (€) / total kWh. Détaillé = variable & fixe (€)
  // ou HP/HC/Base (kWh).
  const lineData = buckets.map((b) => ({
    label: b.label,
    total: isEur ? Math.round(b.hpEur + b.hcEur + b.baseEur + b.aboEur) : b.hpKwh + b.hcKwh + b.baseKwh,
    variable: isEur ? Math.round(b.hpEur + b.hcEur + b.baseEur) : b.hpKwh + b.hcKwh + b.baseKwh,
    abo: Math.round(b.aboEur),
    hp: b.hpKwh, hc: b.hcKwh, base: b.baseKwh,
  }));

  // Histogramme (droite) : empilé par poste (+ abonnement en €), filtrable.
  const barData = buckets.map((b) => ({
    label: b.label,
    hp: isEur ? b.hpEur : b.hpKwh,
    hc: isEur ? b.hcEur : b.hcKwh,
    base: isEur ? b.baseEur : b.baseKwh,
    abo: isEur ? b.aboEur : 0,
  }));
  const showHpHc = poste === "all" || poste === "hphc";
  const showBase = poste === "all" || poste === "base";

  const sitesForCommune = filters.commune ? sites.filter((s) => s.commune_id === filters.commune) : sites;
  const tip = { fontSize: 12, borderRadius: 8, background: "var(--kn-card)", border: "1px solid var(--kn-border)", color: "var(--kn-text)" } as const;
  const seg = (on: boolean) => `rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${on ? "bg-[var(--kn-solid)] text-white" : "text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)]"}`;

  return (
    <div className="mx-auto max-w-6xl px-8 py-6">
      <div className="mb-1 flex items-center gap-2.5">
        <Gauge className="size-6 text-[var(--kn-text)]" strokeWidth={1.75} />
        <h1 className="font-heading text-2xl font-bold text-[var(--kn-text)]">Analyse de consommation</h1>
      </div>
      <p className="mb-4 text-[13px] text-[var(--kn-text-muted)]">
        Évolution de la consommation dans le temps (part variable), répartie au prorata des jours de chaque période de facturation.
      </p>

      {analysis.isDemo && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-[#fed7aa] bg-[var(--kn-yellow-soft)] px-3 py-2 text-[12px] text-[#9a3412]">
          <AlertTriangle className="size-4 shrink-0" />
          Données de démonstration (aucune donnée réelle accessible pour ces filtres — les vraies s&apos;affichent une fois connecté).
        </div>
      )}

      {/* Filtres + contrôles */}
      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-panel)] p-3">
        <FilterSelect label="Commune" value={filters.commune} onChange={(v) => setFilter({ commune: v })}
          options={[{ value: "", label: "Toutes les communes" }, ...communes.map((c) => ({ value: c.id, label: c.nom }))]} />
        <FilterSelect label="Site" value={filters.site} onChange={(v) => setFilter({ site: v })}
          options={[{ value: "", label: "Tous les sites" }, ...sitesForCommune.map((s) => ({ value: s.id, label: s.nom }))]} />
        <FilterSelect label="Catégorie" value={filters.cat} onChange={(v) => setFilter({ cat: v })}
          options={[{ value: "", label: "Toutes" }, { value: "batiment", label: "Bâtiments" }, { value: "eclairage_public", label: "Éclairage public" }]} />
      </div>

      {/* KPIs */}
      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi icon={Zap} label="Consommation totale" value={`${nf(analysis.kpis.totalKwh)} kWh`} />
        <Kpi icon={Euro} label="Coût total" value={`${nf(analysis.kpis.totalCost)} €`} />
        <Kpi icon={Plug} label="Abonnement (part fixe)" value={`${nf(analysis.kpis.aboEur)} €`} />
        <Kpi icon={FileText} label="Factures analysées" value={`${analysis.kpis.invoiceCount}`} />
      </div>

      {analysis.kpis.approxCount > 0 && (
        <p className="mb-4 text-[12px] text-[var(--kn-text-muted)]">
          ⚠️ {analysis.kpis.approxCount} ligne{analysis.kpis.approxCount > 1 ? "s" : ""} sans période détaillée rattachée{analysis.kpis.approxCount > 1 ? "s" : ""} à la date de facture (approximatif).
        </p>
      )}

      {/* Contrôles centrés au-dessus des deux graphiques */}
      <div className="mb-4 flex flex-wrap items-center justify-center gap-3">
        <div className="flex items-center gap-0.5 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] p-1">
          {GRANS.map((g) => <button key={g.id} onClick={() => setGran(g.id)} className={seg(gran === g.id)}>{g.label}</button>)}
        </div>
        <div className="flex items-center gap-0.5 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] p-1">
          <button onClick={() => setMetric("kwh")} className={seg(metric === "kwh")}>kWh</button>
          <button onClick={() => setMetric("eur")} className={seg(metric === "eur")}>€</button>
        </div>
      </div>

      <div className={`grid grid-cols-1 gap-4 lg:grid-cols-2 ${pending ? "opacity-60" : ""}`}>
        {/* Courbe : total ou détaillé dans le temps */}
        <Card
          title={`Évolution de la consommation (${unit})`}
          subtitle={curveMode === "total" ? (isEur ? "total (variable + abonnement)" : "total HP+HC+Base") : (isEur ? "part variable vs abonnement" : "détail par poste")}
          action={
            <div className="flex items-center gap-0.5 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-panel)] p-0.5">
              <button onClick={() => setCurveMode("total")} className={seg(curveMode === "total")}>Total</button>
              <button onClick={() => setCurveMode("detail")} className={seg(curveMode === "detail")}>Détaillé</button>
            </div>
          }
        >
          <ChartBox height={300}>
            {(w) => (
              <LineChart width={w} height={300} data={lineData} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--kn-border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--kn-text-muted)" }} stroke="var(--kn-border)" />
                <YAxis tick={{ fontSize: 12, fill: "var(--kn-text-muted)" }} stroke="var(--kn-border)" />
                <Tooltip formatter={(v, n) => [`${nf(Number(v))} ${unit}`, n]} contentStyle={tip} />
                {curveMode === "detail" && <Legend wrapperStyle={{ fontSize: 12 }} iconSize={9} />}
                {curveMode === "total" && <Line type="monotone" dataKey="total" name="Total" stroke={C.total} strokeWidth={2.5} dot={{ r: 2.5 }} />}
                {curveMode === "detail" && isEur && <Line type="monotone" dataKey="variable" name="Part variable" stroke={C.hp} strokeWidth={2.5} dot={{ r: 2 }} />}
                {curveMode === "detail" && isEur && <Line type="monotone" dataKey="abo" name="Abonnement" stroke="#94a3b8" strokeWidth={2.5} dot={{ r: 2 }} />}
                {curveMode === "detail" && !isEur && <Line type="monotone" dataKey="hp" name="Heures pleines" stroke={C.hp} strokeWidth={2.5} dot={{ r: 2 }} />}
                {curveMode === "detail" && !isEur && <Line type="monotone" dataKey="hc" name="Heures creuses" stroke={C.hc} strokeWidth={2.5} dot={{ r: 2 }} />}
                {curveMode === "detail" && !isEur && <Line type="monotone" dataKey="base" name="Base" stroke={C.base} strokeWidth={2.5} dot={{ r: 2 }} />}
                {lineData.length > 6 && <Brush dataKey="label" height={18} travellerWidth={8} stroke="var(--kn-border)" fill="var(--kn-panel)" />}
              </LineChart>
            )}
          </ChartBox>
        </Card>

        {/* Histogramme : détail par poste (empilé) */}
        <Card
          title={`Détail par poste (${unit})`}
          subtitle="empilé par poste tarifaire"
          action={
            <div className="flex items-center gap-0.5 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-panel)] p-0.5">
              {POSTES.map((p) => <button key={p.id} onClick={() => setPoste(p.id)} className={seg(poste === p.id)}>{p.label}</button>)}
            </div>
          }
        >
          <ChartBox height={300}>
            {(w) => (
              <BarChart width={w} height={300} data={barData} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--kn-border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--kn-text-muted)" }} stroke="var(--kn-border)" />
                <YAxis tick={{ fontSize: 12, fill: "var(--kn-text-muted)" }} stroke="var(--kn-border)" />
                <Tooltip formatter={(v, n) => [`${nf(Number(v))} ${unit}`, n]} contentStyle={tip} />
                <Legend wrapperStyle={{ fontSize: 12 }} iconSize={9} />
                <Bar dataKey="hp" name="Heures pleines" stackId="a" fill={C.hp} hide={!showHpHc} />
                <Bar dataKey="hc" name="Heures creuses" stackId="a" fill={C.hc} hide={!showHpHc} />
                <Bar dataKey="base" name="Base" stackId="a" fill={C.base} hide={!showBase} />
                <Bar dataKey="abo" name="Abonnement" stackId="a" fill={C.abo} radius={[3, 3, 0, 0]} hide={!isEur} />
              </BarChart>
            )}
          </ChartBox>
        </Card>
      </div>
    </div>
  );
}

/** Mesure sa largeur (ResizeObserver) et la passe au chart. Remplace ResponsiveContainer, qui
 *  s'effondre à 9px pour le 2e conteneur avec recharts v3 + React 19. */
function ChartBox({ height, children }: { height: number; children: (width: number) => React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ width: "100%", height }}>
      {width > 0 ? children(width) : null}
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-[var(--kn-text-muted)]">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2.5 text-[13px] text-[var(--kn-text)] focus:border-[var(--kn-text)] focus:outline-none">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function Kpi({ icon: Icon, label, value }: { icon: typeof Zap; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-4">
      <div className="mb-2 flex size-8 items-center justify-center rounded-lg bg-[var(--kn-yellow-soft)]">
        <Icon className="size-4 text-[#ea580c]" strokeWidth={2} />
      </div>
      <p className="text-[12px] text-[var(--kn-text-muted)]">{label}</p>
      <p className="font-heading text-xl font-bold text-[var(--kn-text)]">{value}</p>
    </div>
  );
}

function Card({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="font-heading text-[15px] font-semibold text-[var(--kn-text)]">{title}</h3>
          {subtitle && <p className="text-[12px] text-[var(--kn-text-muted)]">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}
