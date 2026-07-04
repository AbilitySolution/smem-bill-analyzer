import { createClient } from "@/lib/supabase/server";

export interface PivotRow {
  site_id: string;
  site_nom: string;
  commune_nom: string;
  categorie: "batiment" | "eclairage_public";
  facture_date: string;
  total_ttc: number;
  total_kwh: number;
}

export async function getPivotRows(): Promise<PivotRow[]> {
  const supabase = await createClient();

  const { data: invoices } = await supabase
    .from("invoices")
    .select("id, site_id, facture_date, total_ttc, categorie, sites(nom), communes(nom)")
    .order("facture_date");

  const { data: consumption } = await supabase
    .from("consumption_periods")
    .select("invoice_id, consommation_kwh");

  const kwhByInvoice = new Map<string, number>();
  for (const row of consumption ?? []) {
    kwhByInvoice.set(
      row.invoice_id,
      (kwhByInvoice.get(row.invoice_id) ?? 0) + (row.consommation_kwh ?? 0),
    );
  }

  return (invoices ?? []).map((inv) => {
    const i = inv as unknown as {
      id: string;
      site_id: string;
      facture_date: string;
      total_ttc: number;
      categorie: "batiment" | "eclairage_public";
      sites: { nom: string } | null;
      communes: { nom: string } | null;
    };
    return {
      site_id: i.site_id,
      site_nom: i.sites?.nom ?? "—",
      commune_nom: i.communes?.nom ?? "—",
      categorie: i.categorie,
      facture_date: i.facture_date,
      total_ttc: i.total_ttc,
      total_kwh: kwhByInvoice.get(i.id) ?? 0,
    };
  });
}
