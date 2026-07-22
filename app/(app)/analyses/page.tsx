import { createClient } from "@/lib/supabase/server";
import { getConsumptionAnalysis, DEMO_CONSUMPTION, type AnalysisData } from "@/lib/data/consumption";
import { getCoverageData, DEMO_COVERAGE, type CoverageData } from "@/lib/data/coverage";
import { AnalysesTabs } from "@/components/analyses/analyses-tabs";

const EMPTY: AnalysisData = {
  months: [],
  kpis: { totalKwh: 0, varEur: 0, aboEur: 0, totalCost: 0, avgPrice: 0, invoiceCount: 0, approxCount: 0 },
};

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

  let analysis: AnalysisData | null = null;
  let coverage: CoverageData | null = null;
  try {
    [analysis, coverage] = await Promise.all([
      getConsumptionAnalysis({ communeId: sp.commune, siteId: sp.site, categorie: cat }),
      getCoverageData(),
    ]);
  } catch {
    analysis = null;
    coverage = null;
  }
  // null = soit RLS/hors session (→ démo), soit filtres sans donnée (→ vide)
  if (!analysis) analysis = hasFilters ? EMPTY : DEMO_CONSUMPTION;
  if (!coverage) coverage = DEMO_COVERAGE;

  return (
    <AnalysesTabs
      analysis={analysis}
      coverage={coverage}
      communes={communesRes.data ?? []}
      sites={sitesRes.data ?? []}
      filters={{ commune: sp.commune ?? "", site: sp.site ?? "", cat: sp.cat ?? "" }}
    />
  );
}
