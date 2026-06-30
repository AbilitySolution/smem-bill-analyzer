import { createClient } from "@/lib/supabase/server";
import { ExcelBuilder, type BuilderInvoice } from "@/components/documents/excel-builder";

export default async function RapportExcelPage({ searchParams }: { searchParams: Promise<{ ids?: string }> }) {
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
      .order("facture_date", { ascending: false }),
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
    <ExcelBuilder
      communes={communesRes.data ?? []}
      sites={sitesRes.data ?? []}
      invoices={invoices}
      preselectedIds={preIds}
    />
  );
}
