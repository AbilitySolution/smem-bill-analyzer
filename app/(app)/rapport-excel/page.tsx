import { createClient } from "@/lib/supabase/server";
import { getUserContext } from "@/lib/auth";
import { ReportPicker } from "@/components/rapports/report-picker";
import { ReportModal } from "@/components/rapports/report-modal";
import { FileSpreadsheet } from "lucide-react";
import { redirect } from "next/navigation";

export default async function RapportsPage({ searchParams }: { searchParams: Promise<{ ids?: string }> }) {
  const { ids } = await searchParams;
  const preIds = ids ? ids.split(",").filter(Boolean) : [];

  const ctx = await getUserContext();
  if (!ctx) redirect("/login");

  // org_id explicite en plus de la RLS (défense en profondeur), comme sur /analyses.
  const supabase = await createClient();
  const [communesRes, invoiceSiteIds] = await Promise.all([
    supabase.from("communes").select("id, nom, travaux_debut, travaux_estimes").eq("org_id", ctx.orgId).order("nom"),
    supabase.from("invoices").select("site_id").eq("org_id", ctx.orgId).not("site_id", "is", null),
  ]);

  const siteIds = [...new Set((invoiceSiteIds.data ?? []).map((r) => r.site_id as string))];
  const sitesRes = siteIds.length
    ? await supabase.from("sites").select("id, nom, commune_id").eq("org_id", ctx.orgId).in("id", siteIds).order("nom")
    : { data: [] };

  // Communes réellement présentes dans la sélection (pour restreindre le choix du modal).
  let selectionCommuneIds = new Set<string>();
  if (preIds.length) {
    const { data: selInv } = await supabase
      .from("invoices").select("commune_id").eq("org_id", ctx.orgId).in("id", preIds.slice(0, 1000));
    selectionCommuneIds = new Set((selInv ?? []).map((r) => r.commune_id).filter(Boolean) as string[]);
  }
  const selectionCommunes = (communesRes.data ?? []).filter((c) => selectionCommuneIds.has(c.id));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-6">
        <div className="mb-1 flex items-center gap-2">
          <FileSpreadsheet className="size-5 text-[#ea580c]" />
          <h1 className="font-heading text-xl font-bold text-[var(--kn-text)]">Générer un rapport Excel</h1>
        </div>
        <p className="mb-5 text-[13px] text-[var(--kn-text-muted)]">
          Choisissez un type de rapport et un périmètre. Astuce : sélectionnez des factures dans Mes documents
          puis « Exporter Excel » pour préremplir le périmètre.
        </p>

        <ReportPicker
          communes={communesRes.data ?? []}
          sites={sitesRes.data ?? []}
          preselectedIds={preIds}
        />
      </div>

      {preIds.length > 0 && (
        <ReportModal
          ids={preIds}
          communes={selectionCommunes.length ? selectionCommunes : (communesRes.data ?? [])}
        />
      )}
    </div>
  );
}
