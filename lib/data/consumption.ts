import { createClient } from "@/lib/supabase/server";

export type Tarif = "HP" | "HC" | "Base";
export type Metric = "kwh" | "eur" | "cents";

export interface YearRow {
  label: string;
  hpKwh: number; hcKwh: number; baseKwh: number;
  hpEur: number; hcEur: number; baseEur: number;
  hpPx: number | null; hcPx: number | null; basePx: number | null;
}

export interface AnalysisData {
  byYear: YearRow[];
  hpHc: { hpKwh: number; hcKwh: number; hpEur: number; hcEur: number; hpPx: number; hcPx: number };
  kpis: { totalKwh: number; totalCost: number; avgPrice: number; invoiceCount: number };
  isDemo?: boolean;
}

export interface AnalysisFilters {
  communeId?: string;
  siteId?: string;
  categorie?: "batiment" | "eclairage_public";
}

export function classifyTarif(poste: string): Tarif {
  const p = poste.toLowerCase().trim();
  if (p.includes("heures pleines") || p === "hp" || p === "tempo_hp" || p === "ejp_hp" || p === "ejp_hpn") return "HP";
  if (p.includes("heures creuses") || p === "hc" || p === "tempo_hc") return "HC";
  return "Base";
}

interface RawPeriod {
  invoice_id: string;
  poste_tarifaire: string | null;
  period_start: string | null;
  consommation_kwh: number | null;
  prix_unitaire_ckwh: number | null;
  montant_eur: number | null;
  invoices?: { total_ttc?: number | null } | null;
}

function aggregate(rows: RawPeriod[]): AnalysisData {
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

  for (const r of rows) {
    if (!r.period_start) continue;
    invoiceIds.add(r.invoice_id);
    if (!invoiceTotals.has(r.invoice_id)) {
      invoiceTotals.set(r.invoice_id, Number(r.invoices?.total_ttc ?? 0));
    }
    const yr = new Date(r.period_start).getFullYear();
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
  };
}

/** Analyse de consommation réelle (Supabase), filtrable par commune/site/catégorie. */
export async function getConsumptionAnalysis(filters?: AnalysisFilters): Promise<AnalysisData | null> {
  const supabase = await createClient();
  let q = supabase
    .from("consumption_periods")
    .select("invoice_id, poste_tarifaire, period_start, consommation_kwh, prix_unitaire_ckwh, montant_eur, invoices!inner(site_id, commune_id, categorie, total_ttc)");

  if (filters?.communeId) q = q.eq("invoices.commune_id", filters.communeId);
  if (filters?.siteId) q = q.eq("invoices.site_id", filters.siteId);
  if (filters?.categorie) q = q.eq("invoices.categorie", filters.categorie);

  const { data, error } = await q;
  if (error || !data || data.length === 0) return null;
  return aggregate(data as unknown as RawPeriod[]);
}

/** Instantané des VRAIES données agrégées — repli pour le preview public (RLS). */
export const DEMO_CONSUMPTION: AnalysisData = {
  isDemo: true,
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
};
