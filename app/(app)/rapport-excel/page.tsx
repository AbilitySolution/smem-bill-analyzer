import { createClient } from "@/lib/supabase/server";
import { ExcelBuilder, type BuilderInvoice } from "@/components/documents/excel-builder";
import { ReportPicker } from "@/components/rapports/report-picker";
import { FileSpreadsheet } from "lucide-react";

export default async function RapportsPage({ searchParams }: { searchParams: Promise<{ ids?: string }> }) {
  const { ids } = await searchParams;
  const preIds = ids ? ids.split(",").filter(Boolean) : [];

  const supabase = await createClient();
  const [communesRes, sitesRes, invoicesRes] = await Promise.all([
    supabase.from("communes").select("id, nom").order("nom"),
    supabase.from("sites").select("id, nom, commune_id, categorie").order("nom"),
    supabase
      .from("invoices")
      .select("id, facture_number, facture_date, commune_id, site_id, categorie, is_duplicata")
      .eq("archived", false)
      .order("facture_date", { ascending: false })
      .limit(5000),
  ]);

  const invoices: BuilderInvoice[] = (invoicesRes.data ?? []).map((i: Record<string, unknown>) => ({
    id: i.id as string,
    number: (i.facture_number as string) ?? "—",
    date: (i.facture_date as string) ?? "",
    communeId: (i.commune_id as string) ?? "",
    siteId: (i.site_id as string) ?? "",
    categorie: (i.categorie as "batiment" | "eclairage_public") ?? "batiment",
    isDuplicata: !!i.is_duplicata,
  }));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-6">
        <div className="mb-1 flex items-center gap-2">
          <FileSpreadsheet className="size-5 text-[#ea580c]" />
          <h1 className="font-heading text-xl font-bold text-[var(--kn-text)]">Rapports</h1>
        </div>
        <p className="mb-5 text-[13px] text-[var(--kn-text-muted)]">
          Rapports Excel prédéfinis (par commune, par site, synthèse…) et export personnalisé.
        </p>

        <ReportPicker communes={communesRes.data ?? []} sites={sitesRes.data ?? []} />

        <div className="my-6 flex items-center gap-3">
          <div className="h-px flex-1 bg-[var(--kn-border)]" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">Export personnalisé</span>
          <div className="h-px flex-1 bg-[var(--kn-border)]" />
        </div>
      </div>

      <ExcelBuilder
        communes={communesRes.data ?? []}
        sites={sitesRes.data ?? []}
        invoices={invoices}
        preselectedIds={preIds}
      />
    </div>
  );
}
