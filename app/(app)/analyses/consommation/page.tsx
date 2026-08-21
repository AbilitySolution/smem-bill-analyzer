import { createClient } from "@/lib/supabase/server";
import { getUserContext } from "@/lib/auth";
import { getConsumptionAnalysis, DEMO_CONSUMPTION, type AnalysisData } from "@/lib/data/consumption";
import { getInvoiceScope } from "@/lib/data/invoice-scope";
import { AnalysesView } from "@/components/analyses/analyses-view";

const EMPTY: AnalysisData = {
  months: [],
  kpis: { totalKwh: 0, varEur: 0, aboEur: 0, totalCost: 0, avgPrice: 0, invoiceCount: 0, approxCount: 0 },
  coverage: [],
  chained: [],
  panel: { ok: false, siteIds: [], totalSites: 0, from: null, to: null, months: [], excluded: [], siteSpans: [] },
  panelMonths: [],
};

export default async function ConsumptionAnalysisPage({
  searchParams,
}: {
  searchParams: Promise<{ commune?: string; site?: string; cat?: string }>;
}) {
  const sp = await searchParams;
  const cat = sp.cat === "batiment" || sp.cat === "eclairage_public" ? sp.cat : undefined;
  const hasFilters = Boolean(sp.commune || sp.site || sp.cat);

  const ctx = await getUserContext();

  // Pas de session valide (preview public/hors connexion) → données de démo directement,
  // aucune requête réelle (RLS renverrait de toute façon un ensemble vide).
  if (!ctx) {
    return (
      <AnalysesView
        analysis={DEMO_CONSUMPTION}
        communes={[]}
        sites={[]}
        filters={{ commune: sp.commune ?? "", site: sp.site ?? "", cat: sp.cat ?? "" }}
      />
    );
  }

  const supabase = await createClient();
  const [communesRes, invoiceSiteIds, scope] = await Promise.all([
    supabase.from("communes").select("id, nom").eq("org_id", ctx.orgId).eq("archived", false).order("nom"),
    supabase.from("invoices").select("site_id").eq("org_id", ctx.orgId).not("site_id", "is", null),
    getInvoiceScope(ctx.orgId),
  ]);

  // Comme la liste des sites juste en dessous : ne proposer que les communes qui ont des
  // documents. Filtrer sur une commune sans facture ne produit qu'un écran vide.
  const communes = (communesRes.data ?? []).filter((c) => scope.parCommune[c.id]);

  const siteIds = [...new Set((invoiceSiteIds.data ?? []).map((row) => row.site_id as string))];
  const sitesRes = siteIds.length
    ? await supabase.from("sites").select("id, nom, commune_id, categorie").eq("org_id", ctx.orgId).in("id", siteIds).order("nom")
    : { data: [] };

  let analysis: AnalysisData | null = null;
  try {
    analysis = await getConsumptionAnalysis({ orgId: ctx.orgId, communeId: sp.commune, siteId: sp.site, categorie: cat });
  } catch {
    analysis = null;
  }

  // null = filtres sans donnée (→ vide), sinon démo pour une org sans aucune donnée du tout
  if (!analysis) analysis = hasFilters ? EMPTY : DEMO_CONSUMPTION;

  return (
    <AnalysesView
      analysis={analysis}
      communes={communes}
      sites={sitesRes.data ?? []}
      filters={{ commune: sp.commune ?? "", site: sp.site ?? "", cat: sp.cat ?? "" }}
    />
  );
}
