import { createClient } from "@/lib/supabase/server";
import { getConsumptionAnalysis, DEMO_CONSUMPTION, type AnalysisData } from "@/lib/data/consumption";
import { AnalysesView } from "@/components/analyses/analyses-view";

const EMPTY: AnalysisData = {
  months: [],
  kpis: { totalKwh: 0, varEur: 0, aboEur: 0, totalCost: 0, avgPrice: 0, invoiceCount: 0, approxCount: 0 },
};

export default async function ConsumptionAnalysisPage({
  searchParams,
}: {
  searchParams: Promise<{ commune?: string; site?: string; cat?: string }>;
}) {
  const sp = await searchParams;
  const cat = sp.cat === "batiment" || sp.cat === "eclairage_public" ? sp.cat : undefined;
  const hasFilters = Boolean(sp.commune || sp.site || sp.cat);

  const supabase = await createClient();
  const [communesRes, invoiceSiteIds] = await Promise.all([
    supabase.from("communes").select("id, nom").order("nom"),
    supabase.from("invoices").select("site_id").not("site_id", "is", null),
  ]);

  const siteIds = [...new Set((invoiceSiteIds.data ?? []).map((row) => row.site_id as string))];
  const sitesRes = siteIds.length
    ? await supabase.from("sites").select("id, nom, commune_id, categorie").in("id", siteIds).order("nom")
    : { data: [] };

  let analysis: AnalysisData | null = null;
  try {
    analysis = await getConsumptionAnalysis({ communeId: sp.commune, siteId: sp.site, categorie: cat });
  } catch {
    analysis = null;
  }

  if (!analysis) analysis = hasFilters ? EMPTY : DEMO_CONSUMPTION;

  return (
    <AnalysesView
      analysis={analysis}
      communes={communesRes.data ?? []}
      sites={sitesRes.data ?? []}
      filters={{ commune: sp.commune ?? "", site: sp.site ?? "", cat: sp.cat ?? "" }}
    />
  );
}
