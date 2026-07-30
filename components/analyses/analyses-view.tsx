"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { Gauge, Zap, Euro, FileText, AlertTriangle } from "lucide-react";
import type { AnalysisData, Metric } from "@/lib/data/consumption";
import type { ForecastData } from "@/lib/data/forecast";

interface Commune { id: string; nom: string }
interface Site { id: string; nom: string; commune_id: string | null; categorie: string }
interface Filters { commune: string; site: string; cat: string }

const C = { hp: "#ea580c", hc: "#fdba74", base: "#94a3b8" };
const METRICS: { id: Metric; label: string; unit: string }[] = [
  { id: "kwh", label: "kWh", unit: "kWh" },
  { id: "eur", label: "€", unit: "€" },
  { id: "cents", label: "c€/kWh", unit: "c€/kWh" },
];
const nf = (n: number) => n.toLocaleString("fr-FR");

export function AnalysesView({
  analysis, forecast, communes, sites, filters,
}: {
  analysis: AnalysisData;
  forecast: ForecastData;
  communes: Commune[];
  sites: Site[];
  filters: Filters;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [metric, setMetric] = useState<Metric>("kwh");
  const unit = METRICS.find((m) => m.id === metric)!.unit;

  function setFilter(next: Partial<Filters>) {
    const f = { ...filters, ...next };
    if (next.commune !== undefined) f.site = ""; // reset site si commune change
    const params = new URLSearchParams();
    if (f.commune) params.set("commune", f.commune);
    if (f.site) params.set("site", f.site);
    if (f.cat) params.set("cat", f.cat);
    startTransition(() => router.push(`/analyses${params.toString() ? "?" + params : ""}`));
  }

  const lineData = analysis.byYear.map((y) => {
    const v = metric === "kwh" ? [y.hpKwh, y.hcKwh, y.baseKwh]
      : metric === "eur" ? [y.hpEur, y.hcEur, y.baseEur]
      : [y.hpPx ?? null, y.hcPx ?? null, y.basePx ?? null];
    return { label: y.label, hp: v[0], hc: v[1], base: v[2] };
  });

  const barData = analysis.byYear.map((y) => {
    const hp = metric === "kwh" ? y.hpKwh : metric === "eur" ? y.hpEur : (y.hpPx ?? 0);
    const hc = metric === "kwh" ? y.hcKwh : metric === "eur" ? y.hcEur : (y.hcPx ?? 0);
    return { label: y.label, hp, hc };
  });

  const sitesForCommune = filters.commune ? sites.filter((s) => s.commune_id === filters.commune) : sites;

  return (
    <div className="mx-auto max-w-6xl px-8 py-6">
      <div className="mb-1 flex items-center gap-2.5">
        <Gauge className="size-6 text-[var(--kn-text)]" strokeWidth={1.75} />
        <h1 className="font-heading text-2xl font-bold text-[var(--kn-text)]">Analyse de consommation</h1>
      </div>
      <p className="mb-4 text-[13px] text-[var(--kn-text-muted)]">
        Évolution de la consommation et distinction heures pleines / heures creuses, à partir des factures extraites.
      </p>

      {analysis.isDemo && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-[#fed7aa] bg-[var(--kn-yellow-soft)] px-3 py-2 text-[12px] text-[#9a3412]">
          <AlertTriangle className="size-4 shrink-0" />
          Données de démonstration (aucune donnée réelle accessible pour ces filtres — les vraies s&apos;affichent une fois connecté).
        </div>
      )}

      {/* Filtres */}
      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-panel)] p-3">
        <FilterSelect label="Commune" value={filters.commune} onChange={(v) => setFilter({ commune: v })}
          options={[{ value: "", label: "Toutes les communes" }, ...communes.map((c) => ({ value: c.id, label: c.nom }))]} />
        <FilterSelect label="Site" value={filters.site} onChange={(v) => setFilter({ site: v })}
          options={[{ value: "", label: "Tous les sites" }, ...sitesForCommune.map((s) => ({ value: s.id, label: s.nom }))]} />
        <FilterSelect label="Catégorie" value={filters.cat} onChange={(v) => setFilter({ cat: v })}
          options={[{ value: "", label: "Toutes" }, { value: "batiment", label: "Bâtiments" }, { value: "eclairage_public", label: "Éclairage public" }]} />
        <div className="ml-auto flex items-center gap-1 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] p-1 text-[12px]">
          <span className="px-1.5 text-[var(--kn-text-muted)]">Unité :</span>
          {METRICS.map((m) => (
            <button key={m.id} onClick={() => setMetric(m.id)}
              className={`rounded-md px-2.5 py-1 font-medium transition-colors ${metric === m.id ? "bg-[var(--kn-solid)] text-white" : "text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)]"}`}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* KPIs + périmètre */}
      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi icon={FileText} label="Factures analysées" value={`${analysis.kpis.invoiceCount}`} />
        <Kpi icon={Zap} label="Consommation totale" value={`${nf(analysis.kpis.totalKwh)} kWh`} />
        <Kpi icon={Euro} label="Coût total" value={`${nf(analysis.kpis.totalCost)} €`} />
        <Kpi icon={Gauge} label="Prix moyen" value={`${analysis.kpis.avgPrice.toFixed(2)} c€/kWh`} />
      </div>

      <div className={`grid grid-cols-1 gap-4 lg:grid-cols-2 ${pending ? "opacity-60" : ""}`}>
        {/* Courbe évolution */}
        <Card title={`Évolution de la consommation (${unit})`} subtitle="par année et par poste tarifaire">
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={lineData} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--kn-border)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 12, fill: "var(--kn-text-muted)" }} stroke="var(--kn-border)" />
              <YAxis tick={{ fontSize: 12, fill: "var(--kn-text-muted)" }} stroke="var(--kn-border)" />
              <Tooltip formatter={(v, n) => [`${nf(Number(v))} ${unit}`, n]} contentStyle={{ fontSize: 12, borderRadius: 8, background: "var(--kn-card)", border: "1px solid var(--kn-border)", color: "var(--kn-text)" }} />
              <Legend wrapperStyle={{ fontSize: 12 }} iconSize={9} />
              <Line type="monotone" dataKey="hp" name="Heures pleines" stroke={C.hp} strokeWidth={2.5} connectNulls dot={{ r: 3 }} />
              <Line type="monotone" dataKey="hc" name="Heures creuses" stroke={C.hc} strokeWidth={2.5} connectNulls dot={{ r: 3 }} />
              <Line type="monotone" dataKey="base" name="Base" stroke={C.base} strokeWidth={2.5} strokeDasharray="4 3" connectNulls dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        {/* Histogramme HP/HC */}
        <Card title={`Heures pleines / heures creuses (${unit})`} subtitle="comparaison par année">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={barData} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--kn-border)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 12, fill: "var(--kn-text-muted)" }} stroke="var(--kn-border)" />
              <YAxis tick={{ fontSize: 12, fill: "var(--kn-text-muted)" }} stroke="var(--kn-border)" />
              <Tooltip formatter={(v, n) => [`${nf(Number(v))} ${unit}`, n]} contentStyle={{ fontSize: 12, borderRadius: 8, background: "var(--kn-card)", border: "1px solid var(--kn-border)", color: "var(--kn-text)" }} />
              <Legend wrapperStyle={{ fontSize: 12 }} iconSize={9} />
              <Bar dataKey="hp" name="Heures pleines" fill={C.hp} radius={[3, 3, 0, 0]} />
              <Bar dataKey="hc" name="Heures creuses" fill={C.hc} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        {/* Prévision */}
        <div className="lg:col-span-2">
          <Card title="Prévision de consommation (12 prochains mois)" subtitle="estimation heuristique, pas un modèle prédictif entraîné">
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={forecast.months} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--kn-border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12, fill: "var(--kn-text-muted)" }} stroke="var(--kn-border)" />
                <YAxis tick={{ fontSize: 12, fill: "var(--kn-text-muted)" }} stroke="var(--kn-border)" />
                <Tooltip formatter={(v) => [`${nf(Number(v))} kWh`, "Prévision"]} contentStyle={{ fontSize: 12, borderRadius: 8, background: "var(--kn-card)", border: "1px solid var(--kn-border)", color: "var(--kn-text)" }} />
                <Line type="monotone" dataKey="predictedKwh" name="kWh prévus" stroke={C.hp} strokeWidth={2.5} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
            <p className="mt-2 text-[11px] text-[var(--kn-text-muted)]">
              Estimation heuristique basée sur l&apos;historique du site (pondéré selon son ancienneté) et la longueur de
              nuit astronomique / la température (normales climatiques Open-Meteo au-delà de ~16 jours) — pas un modèle
              prédictif entraîné, à affiner avec davantage d&apos;historique.
            </p>
            {forecast.sitesWithoutHistory > 0 && (
              <p className="mt-1 text-[11px] text-[var(--kn-text-muted)]">
                {forecast.sitesWithoutHistory} site{forecast.sitesWithoutHistory > 1 ? "s" : ""} sans facture propre — estimé sur la moyenne de la catégorie uniquement.
              </p>
            )}
            {forecast.weatherUnavailable && (
              <p className="mt-1 flex items-center gap-1 text-[11px] text-[#9a3412]">
                <AlertTriangle className="size-3.5 shrink-0" /> Service météo indisponible — estimation sans ajustement saisonnier.
              </p>
            )}
          </Card>
        </div>
      </div>
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

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-4">
      <div className="mb-3">
        <h3 className="font-heading text-[15px] font-semibold text-[var(--kn-text)]">{title}</h3>
        {subtitle && <p className="text-[12px] text-[var(--kn-text-muted)]">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}
