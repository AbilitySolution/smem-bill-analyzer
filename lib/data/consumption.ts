import { createClient } from "@/lib/supabase/server";

export type Tarif = "HP" | "HC" | "Base";
export type Metric = "kwh" | "eur";

/** Bucket mensuel (granularité atomique). Le client ré-agrège en semestre/année. */
export interface MonthBucket {
  key: string; // "YYYY-MM"
  hpKwh: number; hcKwh: number; baseKwh: number;
  hpEur: number; hcEur: number; baseEur: number; // part variable (€)
  aboEur: number; // abonnement / part fixe (€)
}

export interface AnalysisData {
  months: MonthBucket[]; // triés ascendant
  kpis: {
    totalKwh: number;
    varEur: number;    // part variable € (HP+HC+Base)
    aboEur: number;    // abonnement € (part fixe)
    totalCost: number; // total_ttc réel des factures
    avgPrice: number;  // c€/kWh (part variable)
    invoiceCount: number;
    approxCount: number; // lignes rattachées à la date facture (période absente)
  };
  isDemo?: boolean;
}

export interface AnalysisFilters {
  orgId: string;
  communeId?: string;
  siteId?: string;
  categorie?: "batiment" | "eclairage_public";
}

export function classifyTarif(poste: string): Tarif {
  const p = poste.toLowerCase().trim();
  // startsWith("hp") → hp/hpn/hph/hpjb; includes("_hp") → ejp_hp/ejp_hpn/tempo_hp
  if (p.includes("heures pleines") || p.startsWith("hp") || p.includes("_hp")) return "HP";
  if (p.includes("heures creuses") || p.startsWith("hc") || p.includes("_hc")) return "HC";
  return "Base";
}

const DAY = 86_400_000;
const monthKeyOf = (iso: string) => iso.slice(0, 7); // "YYYY-MM"
const utc = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));

/**
 * Répartit une valeur (kWh ou €) au prorata des jours sur les mois couverts par [start, end]
 * (bornes incluses). Appelle `add(monthKey, fraction)` pour chaque mois chevauché.
 */
function distributeByMonth(start: string, end: string, add: (monthKey: string, fraction: number) => void) {
  const s = utc(start);
  const e = utc(end);
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) {
    add(monthKeyOf(start), 1); // données incohérentes → un seul mois
    return;
  }
  const totalDays = Math.round((e - s) / DAY) + 1;
  let y = +start.slice(0, 4);
  let m = +start.slice(5, 7) - 1; // 0-indexé
  while (true) {
    const mStart = Date.UTC(y, m, 1);
    const mEnd = Date.UTC(y, m + 1, 0); // dernier jour du mois
    if (mStart > e) break;
    const ovStart = Math.max(mStart, s);
    const ovEnd = Math.min(mEnd, e);
    const ovDays = Math.round((ovEnd - ovStart) / DAY) + 1;
    if (ovDays > 0) add(`${y}-${String(m + 1).padStart(2, "0")}`, ovDays / totalDays);
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
}

interface RawPeriod {
  invoice_id: string;
  poste_tarifaire: string | null;
  period_start: string | null;
  period_end: string | null;
  consommation_kwh: number | null;
  montant_eur: number | null;
  invoices?: { facture_date?: string | null; total_ttc?: number | null } | null;
}

interface RawCharge {
  invoice_id: string;
  period_start: string | null;
  period_end: string | null;
  montant_eur: number | null;
  invoices?: { facture_date?: string | null } | null;
}

function aggregate(periods: RawPeriod[], charges: RawCharge[]): AnalysisData {
  const buckets = new Map<string, MonthBucket>();
  const bucket = (key: string): MonthBucket => {
    let b = buckets.get(key);
    if (!b) { b = { key, hpKwh: 0, hcKwh: 0, baseKwh: 0, hpEur: 0, hcEur: 0, baseEur: 0, aboEur: 0 }; buckets.set(key, b); }
    return b;
  };

  const invoiceIds = new Set<string>();
  const invoiceTotals = new Map<string, number>();
  let approxCount = 0;

  for (const r of periods) {
    invoiceIds.add(r.invoice_id);
    if (!invoiceTotals.has(r.invoice_id)) invoiceTotals.set(r.invoice_id, Number(r.invoices?.total_ttc ?? 0));

    const tarif = classifyTarif(r.poste_tarifaire ?? "");
    const kwh = Number(r.consommation_kwh ?? 0);
    const eur = Number(r.montant_eur ?? 0);
    const put = (key: string, f: number) => {
      const b = bucket(key);
      if (tarif === "HP") { b.hpKwh += kwh * f; b.hpEur += eur * f; }
      else if (tarif === "HC") { b.hcKwh += kwh * f; b.hcEur += eur * f; }
      else { b.baseKwh += kwh * f; b.baseEur += eur * f; }
    };

    if (r.period_start && r.period_end) {
      distributeByMonth(r.period_start, r.period_end, put);
    } else {
      // Fallback : période absente → rattacher à la date de facture (marqué approximatif).
      const fd = r.invoices?.facture_date;
      approxCount += 1;
      if (fd) put(monthKeyOf(fd), 1);
    }
  }

  // Part fixe (abonnement) : réparti dans le temps comme la conso, mais uniquement en €.
  for (const c of charges) {
    const eur = Number(c.montant_eur ?? 0);
    if (!eur) continue;
    if (c.period_start && c.period_end) {
      distributeByMonth(c.period_start, c.period_end, (key, f) => { bucket(key).aboEur += eur * f; });
    } else {
      const fd = c.invoices?.facture_date;
      if (fd) bucket(monthKeyOf(fd)).aboEur += eur;
    }
  }

  const months = [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
  const round2 = (n: number) => Math.round(n * 100) / 100;
  for (const b of months) {
    b.hpKwh = Math.round(b.hpKwh); b.hcKwh = Math.round(b.hcKwh); b.baseKwh = Math.round(b.baseKwh);
    b.hpEur = round2(b.hpEur); b.hcEur = round2(b.hcEur); b.baseEur = round2(b.baseEur); b.aboEur = round2(b.aboEur);
  }

  const totalKwh = months.reduce((s, b) => s + b.hpKwh + b.hcKwh + b.baseKwh, 0);
  const varEur = months.reduce((s, b) => s + b.hpEur + b.hcEur + b.baseEur, 0);
  const aboEur = months.reduce((s, b) => s + b.aboEur, 0);
  const totalCost = [...invoiceTotals.values()].reduce((s, v) => s + v, 0);

  return {
    months,
    kpis: {
      totalKwh: Math.round(totalKwh),
      varEur: Math.round(varEur),
      aboEur: Math.round(aboEur),
      totalCost: Math.round(totalCost),
      avgPrice: totalKwh ? +((varEur / totalKwh) * 100).toFixed(2) : 0,
      invoiceCount: invoiceIds.size,
      approxCount,
    },
  };
}

/** Analyse de consommation réelle (Supabase), filtrable par commune/site/catégorie. */
export async function getConsumptionAnalysis(filters: AnalysisFilters): Promise<AnalysisData | null> {
  const supabase = await createClient();

  // org_id explicite en plus de la RLS (défense en profondeur) — l'isolation multi-tenant
  // ne doit pas dépendre uniquement de la policy.
  let pq = supabase
    .from("consumption_periods")
    .select("invoice_id, poste_tarifaire, period_start, period_end, consommation_kwh, montant_eur, invoices!inner(facture_date, site_id, commune_id, categorie, total_ttc, org_id)")
    .eq("invoices.org_id", filters.orgId);
  let cq = supabase
    .from("invoice_charges")
    .select("invoice_id, period_start, period_end, montant_eur, invoices!inner(facture_date, site_id, commune_id, categorie, org_id)")
    .eq("category", "fixed")
    .eq("invoices.org_id", filters.orgId);

  if (filters.communeId) { pq = pq.eq("invoices.commune_id", filters.communeId); cq = cq.eq("invoices.commune_id", filters.communeId); }
  if (filters.siteId) { pq = pq.eq("invoices.site_id", filters.siteId); cq = cq.eq("invoices.site_id", filters.siteId); }
  if (filters.categorie) { pq = pq.eq("invoices.categorie", filters.categorie); cq = cq.eq("invoices.categorie", filters.categorie); }

  const [pRes, cRes] = await Promise.all([pq, cq]);
  if (pRes.error || !pRes.data || pRes.data.length === 0) return null;
  return aggregate(pRes.data as unknown as RawPeriod[], (cRes.data as unknown as RawCharge[]) ?? []);
}

/** Instantané de démonstration (repli hors session / RLS) — quelques mois plausibles. */
export const DEMO_CONSUMPTION: AnalysisData = {
  isDemo: true,
  months: [
    { key: "2023-01", hpKwh: 620, hcKwh: 1180, baseKwh: 0, hpEur: 42, hcEur: 80, baseEur: 0, aboEur: 34 },
    { key: "2023-02", hpKwh: 540, hcKwh: 1020, baseKwh: 0, hpEur: 37, hcEur: 69, baseEur: 0, aboEur: 31 },
    { key: "2023-03", hpKwh: 500, hcKwh: 980, baseKwh: 0, hpEur: 34, hcEur: 66, baseEur: 0, aboEur: 34 },
    { key: "2023-04", hpKwh: 0, hcKwh: 0, baseKwh: 1240, hpEur: 0, hcEur: 0, baseEur: 150, aboEur: 33 },
    { key: "2023-05", hpKwh: 0, hcKwh: 0, baseKwh: 1180, hpEur: 0, hcEur: 0, baseEur: 143, aboEur: 34 },
    { key: "2023-06", hpKwh: 0, hcKwh: 0, baseKwh: 1090, hpEur: 0, hcEur: 0, baseEur: 132, aboEur: 33 },
    { key: "2023-07", hpKwh: 0, hcKwh: 0, baseKwh: 1010, hpEur: 0, hcEur: 0, baseEur: 122, aboEur: 34 },
    { key: "2023-08", hpKwh: 0, hcKwh: 0, baseKwh: 980, hpEur: 0, hcEur: 0, baseEur: 119, aboEur: 34 },
    { key: "2023-09", hpKwh: 430, hcKwh: 900, baseKwh: 0, hpEur: 30, hcEur: 61, baseEur: 0, aboEur: 33 },
    { key: "2023-10", hpKwh: 470, hcKwh: 940, baseKwh: 0, hpEur: 32, hcEur: 64, baseEur: 0, aboEur: 34 },
    { key: "2023-11", hpKwh: 560, hcKwh: 1080, baseKwh: 0, hpEur: 38, hcEur: 73, baseEur: 0, aboEur: 33 },
    { key: "2023-12", hpKwh: 640, hcKwh: 1220, baseKwh: 0, hpEur: 44, hcEur: 83, baseEur: 0, aboEur: 34 },
  ],
  kpis: { totalKwh: 20000, varEur: 1428, aboEur: 401, totalCost: 2130, avgPrice: 7.14, invoiceCount: 8, approxCount: 0 },
};
