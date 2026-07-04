"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

const BUCKET = "invoice-files";

async function requireUser() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return { supabase, user: data.user };
}

/** Masque / réaffiche des factures (colonne archived). */
export async function archiveInvoices(ids: string[], archived: boolean) {
  if (!ids.length) return { error: "Aucune facture sélectionnée." };
  const { supabase, user } = await requireUser();
  if (!user) return { error: "Unauthorized" };

  const { data, error } = await supabase
    .from("invoices")
    .update({ archived })
    .in("id", ids)
    .select("id");
  if (error) return { error: error.message };
  // Aucune ligne renvoyée = mise à jour bloquée en amont (droits/RLS) → on le signale
  // explicitement plutôt que de laisser l'UI « ne rien faire ».
  if (!data || data.length === 0) return { error: "Aucune facture mise à jour — rechargez la page (elles ont peut-être été régénérées)." };

  revalidatePath("/documents");
  return { success: true, count: data.length };
}

/**
 * Supprime définitivement des factures.
 * `anomalies` est en NO ACTION (et `activities` est polymorphe) → on les retire d'abord ;
 * consumption_periods / invoice_charges / corrections_log / invoice_tags cascadent.
 * On retire aussi les fichiers PDF du storage.
 */
export async function deleteInvoices(ids: string[]) {
  if (!ids.length) return { error: "Aucune facture sélectionnée." };
  const { supabase, user } = await requireUser();
  if (!user) return { error: "Unauthorized" };

  // Récupère les chemins de fichiers à purger du storage
  const { data: files } = await supabase.from("invoices").select("file_path").in("id", ids);
  const paths = (files ?? []).map((f) => f.file_path).filter((p): p is string => !!p);

  // Dépendances non-cascade
  await supabase.from("anomalies").delete().in("invoice_id", ids);
  await supabase.from("activities").delete().eq("entity_type", "invoice").in("entity_id", ids);

  const { error } = await supabase.from("invoices").delete().in("id", ids);
  if (error) return { error: error.message };

  if (paths.length) await supabase.storage.from(BUCKET).remove(paths);

  revalidatePath("/documents");
  return { success: true, count: ids.length };
}

export interface SignedFile {
  id: string;
  url: string;
  filename: string;
}

/** URLs signées des PDF originaux pour les factures sélectionnées (ignore celles sans fichier). */
export async function getSignedUrls(ids: string[]): Promise<{ files: SignedFile[]; error?: string }> {
  if (!ids.length) return { files: [], error: "Aucune facture sélectionnée." };
  const { supabase, user } = await requireUser();
  if (!user) return { files: [], error: "Unauthorized" };

  const { data: rows } = await supabase
    .from("invoices")
    .select("id, facture_number, file_path")
    .in("id", ids);

  const files: SignedFile[] = [];
  for (const r of rows ?? []) {
    if (!r.file_path) continue;
    const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(r.file_path, 3600);
    if (signed?.signedUrl) {
      files.push({ id: r.id, url: signed.signedUrl, filename: `${r.facture_number || r.id}.pdf` });
    }
  }
  return { files };
}
