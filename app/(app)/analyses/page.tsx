import { createClient } from "@/lib/supabase/server";
import { getConsumptionAnalysis, DEMO_CONSUMPTION, type AnalysisData } from "@/lib/data/consumption";
import { getConsumptionForecast, DEMO_FORECAST, type ForecastData } from "@/lib/data/forecast";
import { AnalysesView } from "@/components/analyses/analyses-view";

const EMPTY: AnalysisData = {
  byYear: [],
  hpHc: { hpKwh: 0, hcKwh: 0, hpEur: 0, hcEur: 0, hpPx: 0, hcPx: 0 },
  kpis: { totalKwh: 0, totalCost: 0, avgPrice: 0, invoiceCount: 0 },
};

const EMPTY_FORECAST: ForecastData = { months: [], siteCount: 0, sitesWithoutHistory: 0 };

export default async function AnalysesPage({
  searchParams,
}: {
  searchParams: Promise<{ commune?: string; site?: string; cat?: string }>;
}) {
  const sp = await searchParams;
  const cat = sp.cat === "batiment" || sp.cat === "eclairage_public" ? sp.cat : undefined;
  const hasFilters = !!(sp.commune || sp.site || sp.cat);

  const supabase = await createClient();
  const [communesRes, invoiceSiteIds] = await Promise.all([
    supabase.from("communes").select("id, nom").order("nom"),
    supabase.from("invoices").select("site_id").not("site_id", "is", null),
  ]);

  const siteIds = [...new Set((invoiceSiteIds.data ?? []).map((r) => r.site_id as string))];
  const sitesRes = siteIds.length
    ? await supabase.from("sites").select("id, nom, commune_id, categorie").in("id", siteIds).order("nom")
    : { data: [] };

  const [analysisResult, forecastResult] = await Promise.allSettled([
    getConsumptionAnalysis({ communeId: sp.commune, siteId: sp.site, categorie: cat }),
    getConsumptionForecast({ communeId: sp.commune, siteId: sp.site, categorie: cat }),
  ]);

  let analysis = analysisResult.status === "fulfilled" ? analysisResult.value : null;
  let forecast = forecastResult.status === "fulfilled" ? forecastResult.value : null;

  // null = soit RLS/hors session (→ démo), soit filtres sans donnée (→ vide)
  if (!analysis) analysis = hasFilters ? EMPTY : DEMO_CONSUMPTION;
  if (!forecast) forecast = hasFilters ? EMPTY_FORECAST : DEMO_FORECAST;

  return (
    <AnalysesView
      analysis={analysis}
      forecast={forecast}
      communes={communesRes.data ?? []}
      sites={sitesRes.data ?? []}
      filters={{ commune: sp.commune ?? "", site: sp.site ?? "", cat: sp.cat ?? "" }}
    />
  );
}
