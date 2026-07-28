import { addMonths, startOfMonth, endOfMonth, format, getDaysInMonth, differenceInCalendarDays, subYears } from "date-fns";
import { createClient } from "@/lib/supabase/server";
import { computeInvoiceRates, weightedAverageRate, historicalSpan, type InvoicePeriodRow } from "@/lib/forecast/normalize";
import { averageNightLengthHours } from "@/lib/forecast/day-length";
import { fetchHistoricalDailyTemps, fetchForecastDailyTemps, type DailyTemp } from "@/lib/weather/client";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;
export type Categorie = "batiment" | "eclairage_public";

export interface ForecastFilters {
  communeId?: string;
  siteId?: string;
  categorie?: Categorie;
}

export interface ForecastMonthRow {
  label: string; // "2026-08"
  predictedKwh: number;
  isClimatological: boolean;
}

export interface ForecastData {
  months: ForecastMonthRow[];
  siteCount: number;
  sitesWithoutHistory: number;
  weatherUnavailable?: boolean;
  isDemo?: boolean;
}

// Fort-de-France — repli défensif si une commune n'a pas (encore) de coordonnées.
const DEFAULT_LAT = 14.6161;
const DEFAULT_LON = -61.0588;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function averageTemp(temps: DailyTemp[]): number | null {
  if (temps.length === 0) return null;
  return temps.reduce((s, t) => s + t.tempMean, 0) / temps.length;
}

interface SiteRow {
  id: string;
  categorie: Categorie;
  commune_id: string | null;
  communes: { latitude: number | null; longitude: number | null } | null;
}

/** Débit moyen kWh/jour + fenêtre historique, agrégés sur toutes les factures d'une catégorie (indépendant des filtres actifs — sert de "pool" pour le lissage). */
async function categoriePool(supabase: SupabaseServerClient, categorie: Categorie) {
  const { data: catInvoices } = await supabase.from("invoices").select("id").eq("categorie", categorie);
  const ids = (catInvoices ?? []).map((i) => i.id as string);
  if (ids.length === 0) return { rate: null as number | null, span: null as { start: string; end: string } | null };
  const { data: periods } = await supabase
    .from("consumption_periods")
    .select("invoice_id, period_start, period_end, consommation_kwh")
    .in("invoice_id", ids);
  const rates = computeInvoiceRates((periods ?? []) as InvoicePeriodRow[]);
  return { rate: weightedAverageRate(rates), span: historicalSpan(rates) };
}

/**
 * Prévision heuristique de consommation kWh sur les 12 prochains mois.
 * V1 non-ML : débit historique par site, lissé vers une moyenne de catégorie
 * (shrinkage) puis ajusté par un facteur saisonnier (longueur de nuit pour
 * l'éclairage public, température pour les bâtiments). Voir plan de conception
 * pour le détail — architecture pensée pour évoluer vers un modèle statistique
 * une fois davantage de factures accumulées.
 */
export async function getConsumptionForecast(filters?: ForecastFilters): Promise<ForecastData | null> {
  const supabase = await createClient();

  let siteQ = supabase.from("sites").select("id, categorie, commune_id, communes(latitude, longitude)");
  if (filters?.communeId) siteQ = siteQ.eq("commune_id", filters.communeId);
  if (filters?.siteId) siteQ = siteQ.eq("id", filters.siteId);
  if (filters?.categorie) siteQ = siteQ.eq("categorie", filters.categorie);
  const { data: sitesRaw, error: sitesErr } = await siteQ;
  if (sitesErr || !sitesRaw || sitesRaw.length === 0) return null;
  const sites = sitesRaw as unknown as SiteRow[];

  // Historique par site : invoices → consumption_periods (même détour en 2 étapes
  // que la détection d'anomalie existante dans app/api/invoices/route.ts, plus
  // fiable que de filtrer une ressource embarquée avec .in()).
  const siteIds = sites.map((s) => s.id);
  const { data: invoiceRows } = await supabase.from("invoices").select("id, site_id").in("site_id", siteIds);
  const invoiceIds = (invoiceRows ?? []).map((i) => i.id as string);
  const invoiceSiteMap = new Map((invoiceRows ?? []).map((i) => [i.id as string, i.site_id as string]));

  const periodsRaw = invoiceIds.length
    ? ((await supabase.from("consumption_periods").select("invoice_id, period_start, period_end, consommation_kwh").in("invoice_id", invoiceIds)).data ?? [])
    : [];

  const periodsBySite = new Map<string, InvoicePeriodRow[]>();
  for (const p of periodsRaw as InvoicePeriodRow[]) {
    const siteId = invoiceSiteMap.get(p.invoice_id);
    if (!siteId) continue;
    const arr = periodsBySite.get(siteId) ?? [];
    arr.push(p);
    periodsBySite.set(siteId, arr);
  }

  // Pools par catégorie présente dans le périmètre — calculés sur TOUTES les
  // factures de la catégorie, indépendamment des filtres commune/site actifs.
  const categoriesPresent = [...new Set(sites.map((s) => s.categorie))];
  const pools = new Map<Categorie, { rate: number | null; span: { start: string; end: string } | null }>();
  for (const cat of categoriesPresent) {
    pools.set(cat, await categoriePool(supabase, cat));
  }

  const now = new Date();
  const monthStarts = Array.from({ length: 12 }, (_, i) => startOfMonth(addMonths(now, i + 1)));

  let weatherUnavailable = false;
  const climatologyCache = new Map<string, Map<number, number>>();
  const forecastCache = new Map<string, DailyTemp[]>();

  async function getClimatology(lat: number, lon: number): Promise<Map<number, number>> {
    const key = `${lat},${lon}`;
    if (climatologyCache.has(key)) return climatologyCache.get(key)!;
    const end = new Date(now);
    end.setUTCDate(end.getUTCDate() - 1);
    const start = subYears(end, 5);
    try {
      const temps = await fetchHistoricalDailyTemps(lat, lon, format(start, "yyyy-MM-dd"), format(end, "yyyy-MM-dd"));
      const byMonth = new Map<number, { sum: number; count: number }>();
      for (const t of temps) {
        const m = new Date(t.date).getUTCMonth();
        const cur = byMonth.get(m) ?? { sum: 0, count: 0 };
        cur.sum += t.tempMean;
        cur.count++;
        byMonth.set(m, cur);
      }
      const avgByMonth = new Map<number, number>();
      for (const [m, { sum, count }] of byMonth) avgByMonth.set(m, count > 0 ? sum / count : 0);
      climatologyCache.set(key, avgByMonth);
      return avgByMonth;
    } catch {
      weatherUnavailable = true;
      climatologyCache.set(key, new Map());
      return new Map();
    }
  }

  async function getForecastTemps(lat: number, lon: number): Promise<DailyTemp[]> {
    const key = `${lat},${lon}`;
    if (forecastCache.has(key)) return forecastCache.get(key)!;
    try {
      const temps = await fetchForecastDailyTemps(lat, lon);
      forecastCache.set(key, temps);
      return temps;
    } catch {
      weatherUnavailable = true;
      forecastCache.set(key, []);
      return [];
    }
  }

  const monthlyTotals = new Array(12).fill(0) as number[];
  const monthlyIsClimatological = new Array(12).fill(true) as boolean[];
  let sitesWithoutHistory = 0;
  let sitesContributed = 0;

  for (const site of sites) {
    const rates = computeInvoiceRates(periodsBySite.get(site.id) ?? []);
    const siteRate = weightedAverageRate(rates);
    const siteInvoiceCount = rates.length;
    if (siteRate == null) sitesWithoutHistory++;

    const pool = pools.get(site.categorie) ?? { rate: null, span: null };
    const weight = Math.min(1, siteInvoiceCount / 3);
    const blendedRate =
      siteRate == null && pool.rate == null ? null
      : siteRate == null ? pool.rate
      : pool.rate == null ? siteRate
      : weight * siteRate + (1 - weight) * pool.rate;

    if (blendedRate == null) continue; // aucune donnée exploitable, ni site ni pool
    sitesContributed++;

    const lat = site.communes?.latitude ?? DEFAULT_LAT;
    const lon = site.communes?.longitude ?? DEFAULT_LON;
    const referenceSpan = historicalSpan(rates) ?? pool.span;

    let referenceCondition: number | null = null;
    if (site.categorie === "eclairage_public") {
      referenceCondition = referenceSpan
        ? averageNightLengthHours(lat, new Date(referenceSpan.start), new Date(referenceSpan.end))
        : null;
    } else if (referenceSpan) {
      try {
        const temps = await fetchHistoricalDailyTemps(lat, lon, referenceSpan.start, referenceSpan.end);
        referenceCondition = averageTemp(temps);
      } catch {
        weatherUnavailable = true;
        referenceCondition = null;
      }
    }

    for (let i = 0; i < monthStarts.length; i++) {
      const monthStart = monthStarts[i];
      const monthEnd = endOfMonth(monthStart);
      const daysInMonth = getDaysInMonth(monthStart);

      let targetCondition: number | null;
      if (site.categorie === "eclairage_public") {
        targetCondition = averageNightLengthHours(lat, monthStart, monthEnd);
        monthlyIsClimatological[i] = false; // exact, calcul astronomique — pas une climatologie
      } else {
        // Le mois entier doit tenir dans la fenêtre de prévision (~16 j) pour
        // éviter un mélange partiel prévision/climatologie au sein d'un même mois.
        const isClimatological = differenceInCalendarDays(monthEnd, now) > 16;
        if (!isClimatological) {
          const temps = await getForecastTemps(lat, lon);
          const monthTemps = temps.filter((t) => t.date >= format(monthStart, "yyyy-MM-dd") && t.date <= format(monthEnd, "yyyy-MM-dd"));
          targetCondition = averageTemp(monthTemps);
          if (targetCondition == null) monthlyIsClimatological[i] = true;
          else monthlyIsClimatological[i] = false;
        } else {
          const climatology = await getClimatology(lat, lon);
          targetCondition = climatology.get(monthStart.getUTCMonth()) ?? null;
        }
      }

      const factor = referenceCondition != null && targetCondition != null && referenceCondition !== 0
        ? clamp(targetCondition / referenceCondition, 0.3, 3)
        : 1;

      monthlyTotals[i] += blendedRate * daysInMonth * factor;
    }
  }

  if (sitesContributed === 0) return null;

  const months: ForecastMonthRow[] = monthStarts.map((d, i) => ({
    label: format(d, "yyyy-MM"),
    predictedKwh: Math.round(monthlyTotals[i]),
    isClimatological: monthlyIsClimatological[i],
  }));

  return {
    months,
    siteCount: sites.length,
    sitesWithoutHistory,
    ...(weatherUnavailable ? { weatherUnavailable: true } : {}),
  };
}

/** Instantané illustratif — repli pour le preview public (RLS), même rôle que DEMO_CONSUMPTION. */
export const DEMO_FORECAST: ForecastData = {
  isDemo: true,
  siteCount: 8,
  sitesWithoutHistory: 3,
  months: [
    { label: "2026-08", predictedKwh: 2450, isClimatological: true },
    { label: "2026-09", predictedKwh: 2380, isClimatological: true },
    { label: "2026-10", predictedKwh: 2290, isClimatological: true },
    { label: "2026-11", predictedKwh: 2150, isClimatological: true },
    { label: "2026-12", predictedKwh: 2020, isClimatological: true },
    { label: "2027-01", predictedKwh: 1980, isClimatological: true },
    { label: "2027-02", predictedKwh: 1990, isClimatological: true },
    { label: "2027-03", predictedKwh: 2080, isClimatological: true },
    { label: "2027-04", predictedKwh: 2210, isClimatological: true },
    { label: "2027-05", predictedKwh: 2330, isClimatological: true },
    { label: "2027-06", predictedKwh: 2420, isClimatological: true },
    { label: "2027-07", predictedKwh: 2470, isClimatological: true },
  ],
};
