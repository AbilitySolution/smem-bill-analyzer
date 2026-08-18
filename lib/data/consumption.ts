import { createClient } from "@/lib/supabase/server";
import { selectAll } from "@/lib/data/invoices";
import {
  chainedIndex, coverageByMonth, findFixedPanel,
  type ChainedPoint, type CoveragePoint, type FixedPanel, type MonthSiteKwh,
} from "@/lib/data/series-bias";

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
  /**
   * Nombre de sites réellement couverts par mois.
   *
   * Sans cette information, les totaux mensuels sont ININTERPRÉTABLES : sur le
   * portefeuille de production la couverture passe de 1 site (2015) à 9 (2023) puis
   * retombe à 1 (2025), et toute « évolution » lue sur la courbe brute est d'abord
   * celle du versement des factures dans l'outil.
   */
  coverage: CoveragePoint[];
  /** Évolution à périmètre comparable, base 100. `index: null` = série interrompue. */
  chained: ChainedPoint[];
  /** Périmètre figé exploitable (vue par commune / site) — voir `panelMonths`. */
  panel: FixedPanel;
  /** Série en kWh restreinte au périmètre figé. Vide quand `panel.ok` est faux. */
  panelMonths: MonthBucket[];
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
  invoices?: { facture_date?: string | null; total_ttc?: number | null; site_id?: string | null } | null;
}

interface RawCharge {
  invoice_id: string;
  period_start: string | null;
  period_end: string | null;
  montant_eur: number | null;
  invoices?: { facture_date?: string | null; site_id?: string | null } | null;
}

/** Bucket vierge — factorisé, les buckets sont créés à trois endroits. */
function emptyBucket(key: string): MonthBucket {
  return { key, hpKwh: 0, hcKwh: 0, baseKwh: 0, hpEur: 0, hcEur: 0, baseEur: 0, aboEur: 0 };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function roundBucket(b: MonthBucket) {
  b.hpKwh = Math.round(b.hpKwh); b.hcKwh = Math.round(b.hcKwh); b.baseKwh = Math.round(b.baseKwh);
  b.hpEur = round2(b.hpEur); b.hcEur = round2(b.hcEur); b.baseEur = round2(b.baseEur); b.aboEur = round2(b.aboEur);
}

export function aggregate(periods: RawPeriod[], charges: RawCharge[]): AnalysisData {
  const buckets = new Map<string, MonthBucket>();
  const bucket = (key: string): MonthBucket => {
    let b = buckets.get(key);
    if (!b) { b = emptyBucket(key); buckets.set(key, b); }
    return b;
  };

  // Ventilation par (site, mois), en plus du total mensuel. C'est elle qui permet de
  // savoir QUI était couvert QUAND — donc de mesurer le biais de couverture, de chaîner
  // les variations à périmètre comparable, et de restreindre la série à un panel figé.
  const siteBuckets = new Map<string, Map<string, MonthBucket>>();
  const siteBucket = (siteId: string, key: string): MonthBucket => {
    let byMonth = siteBuckets.get(siteId);
    if (!byMonth) { byMonth = new Map(); siteBuckets.set(siteId, byMonth); }
    let b = byMonth.get(key);
    if (!b) { b = emptyBucket(key); byMonth.set(key, b); }
    return b;
  };
  const monthSiteKwh: MonthSiteKwh = new Map();
  const noteCoverage = (key: string, siteId: string, kwh: number) => {
    let inner = monthSiteKwh.get(key);
    if (!inner) { inner = new Map(); monthSiteKwh.set(key, inner); }
    inner.set(siteId, (inner.get(siteId) ?? 0) + kwh);
  };

  const invoiceIds = new Set<string>();
  const invoiceTotals = new Map<string, number>();
  const allSites = new Set<string>();
  let approxCount = 0;

  for (const r of periods) {
    invoiceIds.add(r.invoice_id);
    if (!invoiceTotals.has(r.invoice_id)) invoiceTotals.set(r.invoice_id, Number(r.invoices?.total_ttc ?? 0));

    const tarif = classifyTarif(r.poste_tarifaire ?? "");
    const kwh = Number(r.consommation_kwh ?? 0);
    const eur = Number(r.montant_eur ?? 0);
    const siteId = r.invoices?.site_id ?? null;
    if (siteId) allSites.add(siteId);

    const put = (key: string, f: number) => {
      const apply = (b: MonthBucket) => {
        if (tarif === "HP") { b.hpKwh += kwh * f; b.hpEur += eur * f; }
        else if (tarif === "HC") { b.hcKwh += kwh * f; b.hcEur += eur * f; }
        else { b.baseKwh += kwh * f; b.baseEur += eur * f; }
      };
      apply(bucket(key));
      if (siteId) {
        apply(siteBucket(siteId, key));
        // Un site est « couvert » pour un mois dès qu'une ligne de consommation le
        // recouvre, même à 0 kWh : c'est bien la PRÉSENCE d'une facture qui est en jeu.
        noteCoverage(key, siteId, kwh * f);
      }
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

  // Part fixe (abonnement) : répartie dans le temps comme la conso, mais uniquement en €.
  // Elle n'alimente PAS la couverture : un abonnement peut courir sur une période sans
  // relevé, et compter le site comme couvert donnerait un mois « présent » sans donnée
  // de consommation — donc une variation calculée sur du vide.
  for (const c of charges) {
    const eur = Number(c.montant_eur ?? 0);
    if (!eur) continue;
    const siteId = c.invoices?.site_id ?? null;
    const put = (key: string, f: number) => {
      bucket(key).aboEur += eur * f;
      if (siteId) siteBucket(siteId, key).aboEur += eur * f;
    };
    if (c.period_start && c.period_end) {
      distributeByMonth(c.period_start, c.period_end, put);
    } else {
      const fd = c.invoices?.facture_date;
      if (fd) put(monthKeyOf(fd), 1);
    }
  }

  const months = [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const b of months) roundBucket(b);

  const monthKeys = months.map((m) => m.key);
  const coverage = coverageByMonth(monthSiteKwh, monthKeys);
  const chained = chainedIndex(monthSiteKwh, monthKeys);
  const panel = findFixedPanel(monthSiteKwh, monthKeys, allSites.size);

  // Série restreinte au panel : on ne resomme QUE les sites retenus, sur les seuls mois
  // de la fenêtre. Réutiliser `months` en le tronquant laisserait la contribution des
  // sites exclus — c'est précisément le biais qu'on élimine.
  const panelMonths: MonthBucket[] = [];
  if (panel.ok) {
    const keep = new Set<string>(panel.siteIds);
    for (const key of panel.months) {
      const acc = emptyBucket(key);
      for (const siteId of keep) {
        const b = siteBuckets.get(siteId)?.get(key);
        if (!b) continue;
        acc.hpKwh += b.hpKwh; acc.hcKwh += b.hcKwh; acc.baseKwh += b.baseKwh;
        acc.hpEur += b.hpEur; acc.hcEur += b.hcEur; acc.baseEur += b.baseEur; acc.aboEur += b.aboEur;
      }
      roundBucket(acc);
      panelMonths.push(acc);
    }
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
    coverage,
    chained,
    panel,
    panelMonths,
  };
}

/**
 * Analyse de consommation réelle (Supabase), filtrable par commune/site/catégorie.
 *
 * Deux invariants alignés sur le reste de l'application :
 *   - `archived = false` : une facture archivée est déjà invisible dans Mes documents,
 *     la page Anomalies et le recalcul portefeuille — elle ne doit pas non plus gonfler
 *     les totaux d'analyse ;
 *   - pagination `selectAll` : PostgREST tronque à 1000 lignes par requête, en
 *     silence — sans elle, les analyses sous-comptaient dès ~300 factures.
 */
export async function getConsumptionAnalysis(filters: AnalysisFilters): Promise<AnalysisData | null> {
  const supabase = await createClient();

  // org_id explicite en plus de la RLS (défense en profondeur) — l'isolation multi-tenant
  // ne doit pas dépendre uniquement de la policy. Fabriques : le builder Supabase est
  // mutable, chaque page de `selectAll` doit repartir d'une requête neuve.
  const periodQuery = () => {
    let q = supabase
      .from("consumption_periods")
      .select("invoice_id, poste_tarifaire, period_start, period_end, consommation_kwh, montant_eur, invoices!inner(facture_date, site_id, commune_id, categorie, total_ttc, org_id, archived)")
      .eq("invoices.org_id", filters.orgId)
      .eq("invoices.archived", false);
    if (filters.communeId) q = q.eq("invoices.commune_id", filters.communeId);
    if (filters.siteId) q = q.eq("invoices.site_id", filters.siteId);
    if (filters.categorie) q = q.eq("invoices.categorie", filters.categorie);
    // Ordre total requis : une pagination sans tri stable peut dupliquer ou sauter des lignes.
    return q.order("invoice_id", { ascending: true }).order("id", { ascending: true });
  };
  const chargeQuery = () => {
    let q = supabase
      .from("invoice_charges")
      .select("invoice_id, period_start, period_end, montant_eur, invoices!inner(facture_date, site_id, commune_id, categorie, org_id, archived)")
      .eq("category", "fixed")
      .eq("invoices.org_id", filters.orgId)
      .eq("invoices.archived", false);
    if (filters.communeId) q = q.eq("invoices.commune_id", filters.communeId);
    if (filters.siteId) q = q.eq("invoices.site_id", filters.siteId);
    if (filters.categorie) q = q.eq("invoices.categorie", filters.categorie);
    return q.order("invoice_id", { ascending: true }).order("id", { ascending: true });
  };

  const [periods, charges] = await Promise.all([
    selectAll<RawPeriod>((from, to) => periodQuery().range(from, to)),
    selectAll<RawCharge>((from, to) => chargeQuery().range(from, to)),
  ]);
  if (!periods || periods.length === 0) return null;
  return aggregate(periods, charges ?? []);
}

const DEMO_MONTHS: MonthBucket[] = [
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
];

const DEMO_SITES = ["demo-1", "demo-2", "demo-3", "demo-4"];
const DEMO_MONTH_KEYS = DEMO_MONTHS.map((m) => m.key);

/** Instantané de démonstration (repli hors session / RLS) — quelques mois plausibles. */
export const DEMO_CONSUMPTION: AnalysisData = {
  isDemo: true,
  months: DEMO_MONTHS,
  kpis: { totalKwh: 20000, varEur: 1428, aboEur: 401, totalCost: 2130, avgPrice: 7.14, invoiceCount: 8, approxCount: 0 },
  // La démo simule une couverture PARFAITE et stable (4 sites tous les mois) : c'est le
  // seul cas où une courbe de totaux bruts est directement interprétable, et un écran de
  // démonstration ne doit pas exhiber un biais qui n'existe pas dans ses propres données.
  // Le panel couvre donc toute la période et `panelMonths` est identique à `months` —
  // laisser un panel « ok » avec une série vide serait un état incohérent.
  coverage: DEMO_MONTH_KEYS.map((key) => ({ key, sites: DEMO_SITES.length })),
  chained: DEMO_MONTH_KEYS.map((key, i) => ({ key, index: 100, common: i === 0 ? 0 : DEMO_SITES.length })),
  panel: {
    ok: true,
    siteIds: DEMO_SITES,
    totalSites: DEMO_SITES.length,
    from: DEMO_MONTH_KEYS[0],
    to: DEMO_MONTH_KEYS[DEMO_MONTH_KEYS.length - 1],
    months: DEMO_MONTH_KEYS,
    excluded: [],
    siteSpans: DEMO_SITES.map((siteId) => ({
      siteId,
      firstMonth: DEMO_MONTH_KEYS[0],
      lastMonth: DEMO_MONTH_KEYS[DEMO_MONTH_KEYS.length - 1],
      months: DEMO_MONTH_KEYS.length,
    })),
  },
  panelMonths: DEMO_MONTHS,
};
