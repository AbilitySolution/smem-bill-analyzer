import { createClient } from "@/lib/supabase/server";
import { getConsumptionAnalysis, DEMO_CONSUMPTION, type AnalysisData } from "@/lib/data/consumption";
import { AnalysesView } from "@/components/analyses/analyses-view";

const EMPTY: AnalysisData = {
  byYear: [],
  hpHc: { hpKwh: 0, hcKwh: 0, hpEur: 0, hcEur: 0, hpPx: 0, hcPx: 0 },
  kpis: { totalKwh: 0, totalCost: 0, avgPrice: 0, invoiceCount: 0 },
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
  const [communesRes, sitesRes] = await Promise.all([
    supabase.from("communes").select("id, nom").order("nom"),
    supabase.from("sites").select("id, nom, commune_id, categorie").order("nom"),
  ]);

  let analysis: AnalysisData | null = null;
  try {
    analysis = await getConsumptionAnalysis({ communeId: sp.commune, siteId: sp.site, categorie: cat });
  } catch {
    analysis = null;
  }
  // null = soit RLS/hors session (→ démo), soit filtres sans donnée (→ vide)
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
