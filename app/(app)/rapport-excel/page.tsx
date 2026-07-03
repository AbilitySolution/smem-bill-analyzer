import { createClient } from "@/lib/supabase/server";
import { ReportPicker } from "@/components/rapports/report-picker";
import { FileSpreadsheet } from "lucide-react";

export default async function RapportsPage({ searchParams }: { searchParams: Promise<{ ids?: string }> }) {
  const { ids } = await searchParams;
  const preIds = ids ? ids.split(",").filter(Boolean) : [];

  const supabase = await createClient();
  const [communesRes, sitesRes] = await Promise.all([
    supabase.from("communes").select("id, nom, travaux_debut, travaux_estimes").order("nom"),
    supabase.from("sites").select("id, nom, commune_id").order("nom"),
  ]);

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
    </div>
  );
}
