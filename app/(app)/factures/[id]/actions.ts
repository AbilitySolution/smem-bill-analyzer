"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

const TABLE_FIELDS: Record<string, Set<string>> = {
  invoices: new Set([
    "facture_number", "facture_date", "date_limite_paiement", "date_prochain_releve",
    "date_prochaine_facture", "total_ht", "tva", "autres_taxes", "total_ttc",
    "is_duplicata", "categorie",
  ]),
  clients: new Set(["nom", "reference_client", "reference_compte", "adresse"]),
  contracts: new Set([
    "contract_number", "pdl", "tarif_type", "espace_livraison", "offre", "service",
    "puissance_souscrite_kva", "reglage_protection_a", "type_compteur", "numero_compteur",
  ]),
  sites: new Set(["nom", "pdl", "kva", "ampere", "categorie"]),
  consumption_periods: new Set([
    "poste_tarifaire", "period_start", "period_end", "numero_compteur",
    "ancien_index", "nouveau_index", "coefficient", "consommation_kwh",
    "prix_unitaire_ckwh", "montant_eur", "index_estime",
  ]),
  invoice_charges: new Set([
    "category", "libelle", "period_start", "period_end", "assiette",
    "taux", "taux_numeric", "taux_unit", "montant_eur", "tarif_kva_an",
  ]),
};
const BOOLEAN_FIELDS = new Set(["is_duplicata", "index_estime"]);

const CHILD_TABLES = new Set(["consumption_periods", "invoice_charges"]);

/** Édition générique d'un champ extrait (toutes tables), avec journalisation. */
export async function updateExtractionField(
  invoiceId: string,
  table: string,
  rowId: string,
  field: string,
  oldValue: string | null,
  newValue: string,
) {
  const allowed = TABLE_FIELDS[table];
  if (!allowed || !allowed.has(field)) return { error: "Champ non éditable." };

  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return { error: "Unauthorized" };

  // Verify child rows belong to this invoice (defence-in-depth; RLS also enforces this).
  if (CHILD_TABLES.has(table)) {
    const { data: row } = await supabase
      .from(table)
      .select("invoice_id")
      .eq("id", rowId)
      .maybeSingle();
    if (!row || row.invoice_id !== invoiceId) return { error: "Ligne introuvable." };
  }

  const value: string | number | boolean | null =
    newValue === "" ? null : BOOLEAN_FIELDS.has(field) ? newValue === "true" : newValue;

  const { error } = await supabase.from(table).update({ [field]: value }).eq("id", rowId);
  if (error) return { error: error.message };

  if (table === "invoices") {
    await supabase.from("invoices").update({ status: "reviewed" }).eq("id", invoiceId);
  }

  await supabase.from("corrections_log").insert({
    invoice_id: invoiceId,
    table_name: table,
    row_id: rowId,
    field_name: field,
    old_value: oldValue,
    new_value: newValue,
    corrected_by: authData.user.id,
  });

  revalidatePath(`/factures/${invoiceId}`);
  return { success: true };
}

export async function toggleInvoiceTag(invoiceId: string, tagId: string, checked: boolean) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return { error: "Unauthorized" };

  if (checked) {
    const { error } = await supabase.from("invoice_tags").insert({ invoice_id: invoiceId, tag_id: tagId });
    if (error) return { error: error.message };
  } else {
    const { error } = await supabase.from("invoice_tags").delete().eq("invoice_id", invoiceId).eq("tag_id", tagId);
    if (error) return { error: error.message };
  }
  revalidatePath(`/factures/${invoiceId}`);
  return { success: true };
}

export async function addActivity(invoiceId: string, body: string) {
  if (!body.trim()) return { error: "Note vide." };
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return { error: "Unauthorized" };

  await supabase.from("activities").insert({
    entity_type: "invoice",
    entity_id: invoiceId,
    author_id: authData.user.id,
    body: body.trim(),
  });
  revalidatePath(`/factures/${invoiceId}`);
  return { success: true };
}
