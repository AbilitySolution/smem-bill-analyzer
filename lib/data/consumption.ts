import { createClient } from "@/lib/supabase/server";

export type Tarif = "HP" | "HC" | "Base";
export type Metric = "kwh" | "eur" | "cents";

export interface YearRow {
  label: string;
  hpKwh: number; hcKwh: number; baseKwh: number;
  hpEur: number; hcEur: number; baseEur: number;
  hpPx: number | null; hcPx: number | null; basePx: number | null;
}

const MONTH_LABELS = ["Janv.", "Févr.", "Mars", "Avr.", "Mai", "Juin", "Juil.", "Août", "Sept.", "Oct.", "Nov.", "Déc."];

export interface MonthCompareRow {
  month: number; // 1-12
  label: string;
  currentKwh: number; previousKwh: number;
  currentEur: number; previousEur: number;
  currentPx: number | null; previousPx: number | null;
}

export interface YoyComparison {
  currentYear: string | null;
  previousYear: string | null;
  byMonth: MonthCompareRow[];
}

export interface HeatmapCell { kwh: number; eur: number; px: number | null }
export interface HeatmapRow { siteId: string; site: string; months: (HeatmapCell | null)[] } // index 0 = janvier

export interface AnalysisData {
  byYear: YearRow[];
  hpHc: { hpKwh: number; hcKwh: number; hpEur: number; hcEur: number; hpPx: number; hcPx: number };
  kpis: { totalKwh: number; totalCost: number; avgPrice: number; invoiceCount: number };
  yoy: YoyComparison;
  heatmap: { year: string | null; rows: HeatmapRow[] };
  /** Années présentes dans les données (les plus récentes d'abord) — pour peupler le sélecteur. */
  availableYears: string[];
  isDemo?: boolean;
}

export interface AnalysisFilters {
  orgId: string;
  communeId?: string;
  siteId?: string;
  categorie?: "batiment" | "eclairage_public";
  /** Année choisie pour la comparaison N vs N-1 et la heatmap (défaut : la plus récente). */
  year?: string;
}

export function classifyTarif(poste: string): Tarif {
  const p = poste.toLowerCase().trim();
  // startsWith("hp") → hp/hpn/hph/hpjb; includes("_hp") → ejp_hp/ejp_hpn/tempo_hp
  if (p.includes("heures pleines") || p.startsWith("hp") || p.includes("_hp")) return "HP";
  if (p.includes("heures creuses") || p.startsWith("hc") || p.includes("_hc")) return "HC";
  return "Base";
}

interface RawPeriod {
  invoice_id: string;
  poste_tarifaire: string | null;
  period_start: string | null;
  consommation_kwh: number | null;
  prix_unitaire_ckwh: number | null;
  montant_eur: number | null;
  invoices?: { total_ttc?: number | null; site_id?: string | null; sites?: { nom?: string | null } | null } | null;
}

function aggregate(rows: RawPeriod[], selectedYear?: string): AnalysisData {
  const years = new Map<number, {
    kwh: Record<Tarif, number>; eur: Record<Tarif, number>; pxw: Record<Tarif, { sum: number; w: number }>;
  }>();
  const tot = {
    kwh: { HP: 0, HC: 0, Base: 0 } as Record<Tarif, number>,
    eur: { HP: 0, HC: 0, Base: 0 } as Record<Tarif, number>,
    pxw: { HP: { sum: 0, w: 0 }, HC: { sum: 0, w: 0 }, Base: { sum: 0, w: 0 } } as Record<Tarif, { sum: number; w: number }>,
  };
  const invoiceIds = new Set<string>();
  const invoiceTotals = new Map<string, number>();

  // Totaux (tous postes tarifaires confondus) par année+mois — pour la comparaison N vs N-1.
  const monthlyTotals = new Map<string, { kwh: number; eur: number; pxw: { sum: number; w: number } }>();
  // Totaux par année → site → mois — pour la heatmap.
  type SiteMonth = { kwh: number; eur: number; pxw: { sum: number; w: number } };
  const siteMonthly = new Map<number, Map<string, { site: string; months: SiteMonth[] }>>();

  for (const r of rows) {
    if (!r.period_start) continue;
    invoiceIds.add(r.invoice_id);
    if (!invoiceTotals.has(r.invoice_id)) {
      invoiceTotals.set(r.invoice_id, Number(r.invoices?.total_ttc ?? 0));
    }
    const date = new Date(r.period_start);
    const yr = date.getFullYear();
    const month = date.getMonth() + 1; // 1-12
    const cat = classifyTarif(r.poste_tarifaire ?? "");
    const kwh = Number(r.consommation_kwh ?? 0);
    const eur = Number(r.montant_eur ?? 0);
    const px = r.prix_unitaire_ckwh != null ? Number(r.prix_unitaire_ckwh) : null;

    if (!years.has(yr)) {
      years.set(yr, {
        kwh: { HP: 0, HC: 0, Base: 0 }, eur: { HP: 0, HC: 0, Base: 0 },
        pxw: { HP: { sum: 0, w: 0 }, HC: { sum: 0, w: 0 }, Base: { sum: 0, w: 0 } },
      });
    }
    const y = years.get(yr)!;
    y.kwh[cat] += kwh; y.eur[cat] += eur;
    tot.kwh[cat] += kwh; tot.eur[cat] += eur;
    if (px != null && kwh > 0) {
      y.pxw[cat].sum += px * kwh; y.pxw[cat].w += kwh;
      tot.pxw[cat].sum += px * kwh; tot.pxw[cat].w += kwh;
    }

    const mKey = `${yr}-${month}`;
    if (!monthlyTotals.has(mKey)) monthlyTotals.set(mKey, { kwh: 0, eur: 0, pxw: { sum: 0, w: 0 } });
    const mt = monthlyTotals.get(mKey)!;
    mt.kwh += kwh; mt.eur += eur;
    if (px != null && kwh > 0) { mt.pxw.sum += px * kwh; mt.pxw.w += kwh; }

    const siteId = r.invoices?.site_id ?? null;
    if (siteId) {
      if (!siteMonthly.has(yr)) siteMonthly.set(yr, new Map());
      const yrSites = siteMonthly.get(yr)!;
      if (!yrSites.has(siteId)) {
        yrSites.set(siteId, {
          site: r.invoices?.sites?.nom ?? "—",
          months: Array.from({ length: 12 }, () => ({ kwh: 0, eur: 0, pxw: { sum: 0, w: 0 } })),
        });
      }
      const cell = yrSites.get(siteId)!.months[month - 1];
      cell.kwh += kwh; cell.eur += eur;
      if (px != null && kwh > 0) { cell.pxw.sum += px * kwh; cell.pxw.w += kwh; }
    }
  }

  const sorted = [...years.entries()].sort((a, b) => a[0] - b[0]);
  const round = (n: number) => Math.round(n);
  const px = (s: number, w: number) => (w ? +(s / w).toFixed(2) : null);

  const byYear: YearRow[] = sorted.map(([yr, y]) => ({
    label: String(yr),
    hpKwh: round(y.kwh.HP), hcKwh: round(y.kwh.HC), baseKwh: round(y.kwh.Base),
    hpEur: +y.eur.HP.toFixed(2), hcEur: +y.eur.HC.toFixed(2), baseEur: +y.eur.Base.toFixed(2),
    hpPx: px(y.pxw.HP.sum, y.pxw.HP.w), hcPx: px(y.pxw.HC.sum, y.pxw.HC.w), basePx: px(y.pxw.Base.sum, y.pxw.Base.w),
  }));

  const totalKwh = tot.kwh.HP + tot.kwh.HC + tot.kwh.Base;
  const totalCost = Array.from(invoiceTotals.values()).reduce((s, v) => s + v, 0);

  // Comparaison N vs N-1 : année choisie par l'utilisateur si fournie (et présente dans les
  // données), sinon la plus récente disponible. N-1 = l'année de données la plus proche
  // juste avant N (pas forcément année civile -1, au cas où une année n'a aucune facture).
  const requestedYear = selectedYear ? Number(selectedYear) : null;
  const curYearNum = requestedYear != null && years.has(requestedYear)
    ? requestedYear
    : sorted.length ? sorted[sorted.length - 1][0] : null;
  const curYearIdx = curYearNum != null ? sorted.findIndex(([yr]) => yr === curYearNum) : -1;
  const prevYearNum = curYearIdx > 0 ? sorted[curYearIdx - 1][0] : null;
  const availableYears = sorted.map(([yr]) => String(yr)).reverse();

  const monthTotal = (yr: number | null, m: number) => {
    if (yr == null) return { kwh: 0, eur: 0, px: null as number | null };
    const e = monthlyTotals.get(`${yr}-${m}`);
    if (!e) return { kwh: 0, eur: 0, px: null };
    return { kwh: round(e.kwh), eur: +e.eur.toFixed(2), px: px(e.pxw.sum, e.pxw.w) };
  };

  const yoy: YoyComparison = {
    currentYear: curYearNum != null ? String(curYearNum) : null,
    previousYear: prevYearNum != null ? String(prevYearNum) : null,
    byMonth: MONTH_LABELS.map((label, i) => {
      const m = i + 1;
      const cur = monthTotal(curYearNum, m);
      const prev = monthTotal(prevYearNum, m);
      return {
        month: m, label,
        currentKwh: cur.kwh, previousKwh: prev.kwh,
        currentEur: cur.eur, previousEur: prev.eur,
        currentPx: cur.px, previousPx: prev.px,
      };
    }),
  };

  // Heatmap site × mois, sur l'année la plus récente présente dans les données.
  const siteMap = curYearNum != null ? siteMonthly.get(curYearNum) : undefined;
  const heatmapRows: HeatmapRow[] = siteMap
    ? [...siteMap.entries()]
        .sort((a, b) => a[1].site.localeCompare(b[1].site))
        .map(([siteId, s]) => ({
          siteId,
          site: s.site,
          months: s.months.map((c) =>
            c.kwh > 0 || c.pxw.w > 0 ? { kwh: round(c.kwh), eur: +c.eur.toFixed(2), px: px(c.pxw.sum, c.pxw.w) } : null,
          ),
        }))
    : [];

  return {
    byYear,
    hpHc: {
      hpKwh: round(tot.kwh.HP), hcKwh: round(tot.kwh.HC),
      hpEur: +tot.eur.HP.toFixed(2), hcEur: +tot.eur.HC.toFixed(2),
      hpPx: px(tot.pxw.HP.sum, tot.pxw.HP.w) ?? 0, hcPx: px(tot.pxw.HC.sum, tot.pxw.HC.w) ?? 0,
    },
    kpis: {
      totalKwh: round(totalKwh),
      totalCost: round(totalCost),
      avgPrice: totalKwh ? +((totalCost / totalKwh) * 100).toFixed(2) : 0,
      invoiceCount: invoiceIds.size,
    },
    yoy,
    heatmap: { year: curYearNum != null ? String(curYearNum) : null, rows: heatmapRows },
    availableYears,
  };
}

/** Analyse de consommation réelle (Supabase), filtrable par commune/site/catégorie. */
export async function getConsumptionAnalysis(filters: AnalysisFilters): Promise<AnalysisData | null> {
  const supabase = await createClient();
  let q = supabase
    .from("consumption_periods")
    .select("invoice_id, poste_tarifaire, period_start, consommation_kwh, prix_unitaire_ckwh, montant_eur, invoices!inner(site_id, commune_id, categorie, total_ttc, org_id, sites(nom))")
    .eq("invoices.org_id", filters.orgId);

  if (filters?.communeId) q = q.eq("invoices.commune_id", filters.communeId);
  if (filters?.siteId) q = q.eq("invoices.site_id", filters.siteId);
  if (filters?.categorie) q = q.eq("invoices.categorie", filters.categorie);

  const { data, error } = await q;
  if (error || !data || data.length === 0) return null;
  return aggregate(data as unknown as RawPeriod[], filters.year);
}

/** Instantané des VRAIES données agrégées — repli pour le preview public (RLS). */
export const DEMO_CONSUMPTION: AnalysisData = {
  isDemo: true,
  availableYears: ["2023", "2022", "2021", "2020", "2018", "2017"],
  byYear: [
    { label: "2017", hpKwh: 3356, hcKwh: 7207, baseKwh: 0, hpEur: 228.29, hcEur: 490.27, baseEur: 0, hpPx: 6.81, hcPx: 6.80, basePx: null },
    { label: "2018", hpKwh: 5340, hcKwh: 8903, baseKwh: 0, hpEur: 270.47, hcEur: 442.96, baseEur: 0, hpPx: 6.51, hcPx: 6.51, basePx: null },
    { label: "2020", hpKwh: 303, hcKwh: 150, baseKwh: 0, hpEur: 35.5, hcEur: 12.36, baseEur: 0, hpPx: 11.72, hcPx: 8.24, basePx: null },
    { label: "2021", hpKwh: 42, hcKwh: 21, baseKwh: 0, hpEur: 5.31, hcEur: 1.86, baseEur: 0, hpPx: 12.64, hcPx: 8.85, basePx: null },
    { label: "2022", hpKwh: 0, hcKwh: 0, baseKwh: 3313, hpEur: 0, hcEur: 0, baseEur: 198.42, hpPx: null, hcPx: null, basePx: 11.86 },
    { label: "2023", hpKwh: 0, hcKwh: 0, baseKwh: 1721, hpEur: 0, hcEur: 0, baseEur: 232.32, hpPx: null, hcPx: null, basePx: 14.08 },
  ],
  hpHc: { hpKwh: 9041, hcKwh: 16281, hpEur: 539.57, hcEur: 947.45, hpPx: 5.97, hcPx: 5.82 },
  kpis: { totalKwh: 30356, totalCost: 2012, avgPrice: 6.63, invoiceCount: 6 },
  yoy: {
    currentYear: "2023",
    previousYear: "2022",
    byMonth: [
      { month: 1, label: "Janv.", currentKwh: 180, previousKwh: 340, currentEur: 24.3, previousEur: 20.37, currentPx: 14.08, previousPx: 11.86 },
      { month: 2, label: "Févr.", currentKwh: 165, previousKwh: 310, currentEur: 22.28, previousEur: 18.57, currentPx: 14.08, previousPx: 11.86 },
      { month: 3, label: "Mars", currentKwh: 150, previousKwh: 290, currentEur: 20.25, previousEur: 17.37, currentPx: 14.08, previousPx: 11.86 },
      { month: 4, label: "Avr.", currentKwh: 120, previousKwh: 230, currentEur: 16.2, previousEur: 13.78, currentPx: 14.08, previousPx: 11.86 },
      { month: 5, label: "Mai", currentKwh: 100, previousKwh: 190, currentEur: 13.5, previousEur: 11.38, currentPx: 14.08, previousPx: 11.86 },
      { month: 6, label: "Juin", currentKwh: 90, previousKwh: 170, currentEur: 12.15, previousEur: 10.18, currentPx: 14.08, previousPx: 11.86 },
      { month: 7, label: "Juil.", currentKwh: 85, previousKwh: 160, currentEur: 11.48, previousEur: 9.58, currentPx: 14.08, previousPx: 11.86 },
      { month: 8, label: "Août", currentKwh: 95, previousKwh: 180, currentEur: 12.82, previousEur: 10.78, currentPx: 14.08, previousPx: 11.86 },
      { month: 9, label: "Sept.", currentKwh: 110, previousKwh: 210, currentEur: 14.85, previousEur: 12.58, currentPx: 14.08, previousPx: 11.86 },
      { month: 10, label: "Oct.", currentKwh: 140, previousKwh: 270, currentEur: 18.9, previousEur: 16.17, currentPx: 14.08, previousPx: 11.86 },
      { month: 11, label: "Nov.", currentKwh: 160, previousKwh: 310, currentEur: 21.6, previousEur: 18.57, currentPx: 14.08, previousPx: 11.86 },
      { month: 12, label: "Déc.", currentKwh: 326, previousKwh: 653, currentEur: 44.01, previousEur: 39.12, currentPx: 14.08, previousPx: 11.86 },
    ],
  },
  heatmap: {
    year: "2023",
    rows: [
      {
        siteId: "demo-1", site: "Éclairage public Bourg",
        months: [
          { kwh: 95, eur: 12.83, px: 13.5 }, { kwh: 90, eur: 12.15, px: 13.5 }, { kwh: 85, eur: 11.48, px: 13.5 },
          { kwh: 70, eur: 9.45, px: 13.5 }, { kwh: 55, eur: 7.43, px: 13.5 }, { kwh: 50, eur: 6.75, px: 13.5 },
          { kwh: 48, eur: 6.48, px: 13.5 }, { kwh: 52, eur: 7.02, px: 13.5 }, { kwh: 60, eur: 8.1, px: 13.5 },
          { kwh: 75, eur: 10.13, px: 13.5 }, { kwh: 85, eur: 11.48, px: 13.5 }, { kwh: 110, eur: 14.85, px: 13.5 },
        ],
      },
      {
        siteId: "demo-2", site: "Mairie annexe",
        months: [
          { kwh: 40, eur: 5.4, px: 13.5 }, { kwh: 38, eur: 5.13, px: 13.5 }, { kwh: 35, eur: 4.73, px: 13.5 },
          { kwh: 42, eur: 5.67, px: 13.5 }, { kwh: 45, eur: 6.08, px: 13.5 }, { kwh: 48, eur: 6.48, px: 13.5 },
          { kwh: 50, eur: 6.75, px: 13.5 }, { kwh: 47, eur: 6.35, px: 13.5 }, { kwh: 43, eur: 5.81, px: 13.5 },
          { kwh: 40, eur: 5.4, px: 13.5 }, { kwh: 38, eur: 5.13, px: 13.5 }, { kwh: 42, eur: 5.67, px: 13.5 },
        ],
      },
      {
        siteId: "demo-3", site: "École primaire",
        months: [
          { kwh: 30, eur: 4.05, px: 13.5 }, { kwh: 28, eur: 3.78, px: 13.5 }, { kwh: 25, eur: 3.38, px: 13.5 },
          { kwh: 20, eur: 2.7, px: 13.5 }, { kwh: 18, eur: 2.43, px: 13.5 }, null, null,
          { kwh: 15, eur: 2.03, px: 13.5 }, { kwh: 25, eur: 3.38, px: 13.5 }, { kwh: 28, eur: 3.78, px: 13.5 },
          { kwh: 30, eur: 4.05, px: 13.5 }, { kwh: 32, eur: 4.32, px: 13.5 },
        ],
      },
    ],
  },
};
