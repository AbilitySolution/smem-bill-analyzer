"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, Brush,
} from "recharts";
import { Gauge, Zap, Euro, FileText, AlertTriangle, Plug, Layers, Info } from "lucide-react";
import type { AnalysisData, Metric, MonthBucket } from "@/lib/data/consumption";
import { MIN_PANEL_COVERAGE, MIN_PANEL_MONTHS } from "@/lib/data/series-bias";

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

/** Clé de bucket d'un mois "YYYY-MM", pour aligner couverture et indice sur la courbe. */
function bucketKeyOf(monthKey: string, gran: Gran): string {
  const y = monthKey.slice(0, 4);
  const mo = +monthKey.slice(5, 7);
  if (gran === "year") return y;
  if (gran === "semester") return `${y}-${mo <= 6 ? 1 : 2}`;
  return monthKey;
}

/** "2023-05" → "mai 2023" */
function frMonth(key: string): string {
  return `${MO[+key.slice(5, 7) - 1]} ${key.slice(0, 4)}`;
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
  const [scopeMode, setScopeMode] = useState<"brut" | "comparable">("brut");
  const unit = metric === "kwh" ? "kWh" : "€";
  const isEur = metric === "eur";

  // Un filtre commune ou site restreint le périmètre : on bascule alors sur le panel
  // figé, seul moyen d'afficher une VRAIE évolution en kWh. Sur tout le portefeuille,
  // aucun panel n'aurait de sens (2 sites sur 17 seraient retenus) — on y répond par
  // la couverture affichée et l'indice chaîné.
  const restricted = Boolean(filters.commune || filters.site);
  const panel = analysis.panel;
  const panelBlocked = restricted && !panel.ok;
  const series = restricted && panel.ok ? analysis.panelMonths : analysis.months;

  function setFilter(next: Partial<Filters>) {
    const f = { ...filters, ...next };
    if (next.commune !== undefined) f.site = "";
    const params = new URLSearchParams();
    if (f.commune) params.set("commune", f.commune);
    if (f.site) params.set("site", f.site);
    if (f.cat) params.set("cat", f.cat);
    startTransition(() => router.push(`/analyses/consommation${params.toString() ? "?" + params : ""}`));
  }

  const buckets = useMemo(() => reBucket(series, gran), [series, gran]);

  // Couverture ré-agrégée à la granularité choisie : moyenne des sites couverts sur la
  // période. La moyenne plutôt que le max — un semestre couvert un seul mois sur six ne
  // doit pas s'afficher comme pleinement couvert.
  const coverageByBucket = useMemo(() => {
    const acc = new Map<string, { sum: number; n: number }>();
    for (const c of analysis.coverage) {
      const k = bucketKeyOf(c.key, gran);
      const a = acc.get(k) ?? { sum: 0, n: 0 };
      a.sum += c.sites; a.n += 1;
      acc.set(k, a);
    }
    return acc;
  }, [analysis.coverage, gran]);

  // Indice chaîné : on retient la DERNIÈRE valeur de chaque période (indice de fin de
  // période, convention usuelle). Une moyenne d'indices n'aurait pas de sens : un indice
  // est un niveau cumulé, pas un flux qu'on additionne ou qu'on moyenne.
  const chainedByBucket = useMemo(() => {
    const acc = new Map<string, number | null>();
    for (const c of analysis.chained) acc.set(bucketKeyOf(c.key, gran), c.index);
    return acc;
  }, [analysis.chained, gran]);

  const siteNameById = useMemo(() => new Map(sites.map((s) => [s.id, s.nom])), [sites]);
  const showComparable = !restricted && scopeMode === "comparable";

  // Courbe (gauche). Total = variable+abonnement (€) / total kWh. Détaillé = variable & fixe (€)
  // ou HP/HC/Base (kWh).
  const lineData = buckets.map((b) => {
    const cov = coverageByBucket.get(b.order);
    return {
      label: b.label,
      total: isEur ? Math.round(b.hpEur + b.hcEur + b.baseEur + b.aboEur) : b.hpKwh + b.hcKwh + b.baseKwh,
      variable: isEur ? Math.round(b.hpEur + b.hcEur + b.baseEur) : b.hpKwh + b.hcKwh + b.baseKwh,
      abo: Math.round(b.aboEur),
      hp: b.hpKwh, hc: b.hcKwh, base: b.baseKwh,
      sites: cov && cov.n > 0 ? Math.round((cov.sum / cov.n) * 10) / 10 : 0,
      // `null` interrompt le tracé chez recharts : c'est exactement le comportement
      // voulu quand la chaîne est rompue faute de sites communs.
      indice: chainedByBucket.get(b.order) ?? null,
    };
  });

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

      {/* KPIs. « Prix moyen » est la même unité que la détection d'anomalies de coût
          (c€/kWh, part variable seule) : les deux pages parlent la même langue. */}
      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Kpi icon={Zap} label="Consommation totale" value={`${nf(analysis.kpis.totalKwh)} kWh`} />
        <Kpi icon={Euro} label="Coût total" value={`${nf(analysis.kpis.totalCost)} €`} />
        <Kpi icon={Gauge} label="Prix moyen (variable)" value={`${analysis.kpis.avgPrice.toLocaleString("fr-FR")} c€/kWh`} />
        <Kpi icon={Plug} label="Abonnement (part fixe)" value={`${nf(analysis.kpis.aboEur)} €`} />
        <Kpi icon={FileText} label="Factures analysées" value={`${analysis.kpis.invoiceCount}`} />
      </div>

      {analysis.kpis.approxCount > 0 && (
        <p className="mb-4 text-[12px] text-[var(--kn-text-muted)]">
          ⚠️ {analysis.kpis.approxCount} ligne{analysis.kpis.approxCount > 1 ? "s" : ""} sans période détaillée rattachée{analysis.kpis.approxCount > 1 ? "s" : ""} à la date de facture (approximatif).
        </p>
      )}

      {/* Périmètre : ce bandeau dit sur QUOI porte la courbe. Sans lui, une série de
          totaux mensuels sur un portefeuille à couverture variable se lit comme une
          évolution de consommation alors qu'elle décrit surtout l'avancement du
          versement des factures. */}
      {restricted && panel.ok && (
        <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-panel)] px-3 py-2.5">
          <Layers className="mt-0.5 size-4 shrink-0 text-[var(--kn-text-muted)]" />
          <p className="text-[12px] text-[var(--kn-text)]">
            <strong>Périmètre constant</strong> — {panel.siteIds.length} site{panel.siteIds.length > 1 ? "s" : ""} sur {panel.totalSites},
            de {panel.from ? frMonth(panel.from) : "?"} à {panel.to ? frMonth(panel.to) : "?"}.
            {panel.excluded.length > 0 && (
              <span className="text-[var(--kn-text-muted)]">
                {" "}Exclus faute de couverture continue :{" "}
                {panel.excluded.map((e) => `${siteNameById.get(e.siteId) ?? "site inconnu"}${e.firstMonth ? ` (depuis ${frMonth(e.firstMonth)})` : ""}`).join(", ")}.
              </span>
            )}
          </p>
        </div>
      )}

      {panelBlocked ? (
        <PanelBlocked panel={panel} siteNameById={siteNameById} />
      ) : (
        <>
      {/* Contrôles centrés au-dessus des deux graphiques */}
      <div className="mb-4 flex flex-wrap items-center justify-center gap-3">
        <div className="flex items-center gap-0.5 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] p-1">
          {GRANS.map((g) => <button key={g.id} onClick={() => setGran(g.id)} className={seg(gran === g.id)}>{g.label}</button>)}
        </div>
        <div className="flex items-center gap-0.5 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] p-1">
          <button onClick={() => setMetric("kwh")} className={seg(metric === "kwh")}>kWh</button>
          <button onClick={() => setMetric("eur")} className={seg(metric === "eur")}>€</button>
        </div>
        {!restricted && (
          <div className="flex items-center gap-0.5 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] p-1">
            <button onClick={() => setScopeMode("brut")} className={seg(scopeMode === "brut")}>Totaux bruts</button>
            <button onClick={() => setScopeMode("comparable")} className={seg(scopeMode === "comparable")}>Périmètre comparable</button>
          </div>
        )}
      </div>

      <div className={`grid grid-cols-1 gap-4 lg:grid-cols-2 ${pending ? "opacity-60" : ""}`}>
        {/* Courbe : total, détaillé, ou indice chaîné à périmètre comparable */}
        <Card
          title={showComparable ? "Évolution à périmètre comparable (base 100)" : `Évolution de la consommation (${unit})`}
          subtitle={
            showComparable
              ? "variations calculées mois par mois sur les seuls sites présents dans les deux mois"
              : curveMode === "total"
                ? (isEur ? "total (variable + abonnement)" : "total HP+HC+Base")
                : (isEur ? "part variable vs abonnement" : "détail par poste")
          }
          action={!showComparable && (
            <div className="flex items-center gap-0.5 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-panel)] p-0.5">
              <button onClick={() => setCurveMode("total")} className={seg(curveMode === "total")}>Total</button>
              <button onClick={() => setCurveMode("detail")} className={seg(curveMode === "detail")}>Détaillé</button>
            </div>
          )}
        >
          <ChartBox height={300}>
            {(w) => (
              <LineChart width={w} height={300} data={lineData} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--kn-border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--kn-text-muted)" }} stroke="var(--kn-border)" />
                <YAxis tick={{ fontSize: 12, fill: "var(--kn-text-muted)" }} stroke="var(--kn-border)" />
                <Tooltip contentStyle={tip}
                  formatter={(v, n) => [
                    n === "Indice" ? nf(Number(v)) : n === "Sites couverts" ? String(v) : `${nf(Number(v))} ${unit}`,
                    n,
                  ]} />
                {(curveMode === "detail" || showComparable) && <Legend wrapperStyle={{ fontSize: 12 }} iconSize={9} />}
                {showComparable
                  ? <Line type="monotone" dataKey="indice" name="Indice" stroke={C.total} strokeWidth={2.5} dot={{ r: 2.5 }} connectNulls={false} />
                  : <>
                      {curveMode === "total" && <Line type="monotone" dataKey="total" name="Total" stroke={C.total} strokeWidth={2.5} dot={{ r: 2.5 }} />}
                      {curveMode === "detail" && isEur && <Line type="monotone" dataKey="variable" name="Part variable" stroke={C.hp} strokeWidth={2.5} dot={{ r: 2 }} />}
                      {curveMode === "detail" && isEur && <Line type="monotone" dataKey="abo" name="Abonnement" stroke="#94a3b8" strokeWidth={2.5} dot={{ r: 2 }} />}
                      {curveMode === "detail" && !isEur && <Line type="monotone" dataKey="hp" name="Heures pleines" stroke={C.hp} strokeWidth={2.5} dot={{ r: 2 }} />}
                      {curveMode === "detail" && !isEur && <Line type="monotone" dataKey="hc" name="Heures creuses" stroke={C.hc} strokeWidth={2.5} dot={{ r: 2 }} />}
                      {curveMode === "detail" && !isEur && <Line type="monotone" dataKey="base" name="Base" stroke={C.base} strokeWidth={2.5} dot={{ r: 2 }} />}
                    </>}
                {lineData.length > 6 && <Brush dataKey="label" height={18} travellerWidth={8} stroke="var(--kn-border)" fill="var(--kn-panel)" />}
              </LineChart>
            )}
          </ChartBox>

          {/* Bande de couverture : le garde-fou. Elle rend le biais visible en permanence,
              y compris en mode « totaux bruts » où il est le plus trompeur. Inutile sur un
              périmètre figé, où la couverture est constante par construction. */}
          {!restricted && (
            <div className="mt-2 border-t border-[var(--kn-border)] pt-2">
              <p className="mb-1 text-[11px] text-[var(--kn-text-muted)]">
                Sites couverts par période — un point de la courbe ne vaut que ce que vaut sa couverture
              </p>
              <ChartBox height={64}>
                {(w) => (
                  <BarChart width={w} height={64} data={lineData} margin={{ top: 2, right: 12, left: -8, bottom: 0 }}>
                    <XAxis dataKey="label" hide />
                    <YAxis allowDecimals={false} width={28} tick={{ fontSize: 10, fill: "var(--kn-text-muted)" }} stroke="var(--kn-border)" />
                    <Tooltip contentStyle={tip} formatter={(v) => [`${v} site(s)`, "Sites couverts"]} />
                    <Bar dataKey="sites" name="Sites couverts" fill="#94a3b8" radius={[2, 2, 0, 0]} />
                  </BarChart>
                )}
              </ChartBox>
            </div>
          )}
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
        </>
      )}
    </div>
  );
}

/**
 * Écran de refus : aucune fenêtre ne permet une série honnête sur ce périmètre.
 *
 * Afficher malgré tout une courbe « de la commune » construite sur une minorité de ses
 * sites, ou sur une poignée de mois, produirait une évolution qui n'existe pas. Le
 * message nomme donc les sites qui manquent et depuis quand ils sont couverts : c'est
 * une consigne de travail, pas une erreur.
 */
function PanelBlocked({ panel, siteNameById }: {
  panel: AnalysisData["panel"];
  siteNameById: Map<string, string>;
}) {
  const needed = Math.max(1, Math.ceil(MIN_PANEL_COVERAGE * panel.totalSites));
  const found = panel.siteIds.length;
  const months = panel.months.length;

  return (
    <div className="rounded-xl border border-dashed border-[var(--kn-border)] bg-[var(--kn-panel)] p-6">
      <div className="mb-3 flex items-center gap-2.5">
        <Info className="size-5 shrink-0 text-[#ea580c]" />
        <h3 className="font-heading text-[15px] font-semibold text-[var(--kn-text)]">
          Évolution non affichable sur ce périmètre
        </h3>
      </div>
      <p className="mb-3 max-w-2xl text-[13px] text-[var(--kn-text)]">
        Pour tracer une évolution qui décrive réellement la consommation, il faut un ensemble de sites
        couverts <strong>sans interruption</strong> sur au moins <strong>{MIN_PANEL_MONTHS} mois</strong> consécutifs
        (un cycle saisonnier complet) et représentant au moins <strong>{Math.round(MIN_PANEL_COVERAGE * 100)} %</strong> des sites
        du périmètre — soit {needed} site{needed > 1 ? "s" : ""} sur {panel.totalSites}.
      </p>
      <p className="mb-4 max-w-2xl text-[13px] text-[var(--kn-text-muted)]">
        {months > 0
          ? <>La meilleure fenêtre trouvée ne réunit que <strong>{found} site{found > 1 ? "s" : ""}</strong> sur {months} mois consécutifs — insuffisant. </>
          : <>Aucune fenêtre continue n&apos;a été trouvée sur ce périmètre. </>}
        Une courbe tracée dans ces conditions mélangerait des mois où les sites couverts ne sont pas les mêmes :
        elle montrerait l&apos;avancement du versement des factures, pas l&apos;évolution de la consommation.
      </p>

      {/* On s'appuie sur les empans de couverture, pas sur les sites « exclus » : quand la
          meilleure fenêtre est simplement trop courte, elle contient tous les sites et la
          liste des exclus est vide — l'utilisateur n'aurait alors aucune explication. */}
      {panel.siteSpans.length > 0 && (
        <div className="mb-4">
          <p className="mb-1.5 text-[12px] font-medium text-[var(--kn-text)]">
            Couverture réelle de chaque site — les moins couverts en premier :
          </p>
          <ul className="space-y-1">
            {panel.siteSpans.map((s) => (
              <li key={s.siteId} className="text-[12px] text-[var(--kn-text-muted)]">
                • <span className="text-[var(--kn-text)]">{siteNameById.get(s.siteId) ?? "Site inconnu"}</span>
                {" — "}{s.months} mois couvert{s.months > 1 ? "s" : ""}, de {frMonth(s.firstMonth)} à {frMonth(s.lastMonth)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <a href="/analyses/couverture"
        className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-3 py-2 text-[12px] font-medium text-[var(--kn-text)] transition-colors hover:bg-[var(--kn-active)]">
        Voir la couverture détaillée
      </a>
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
