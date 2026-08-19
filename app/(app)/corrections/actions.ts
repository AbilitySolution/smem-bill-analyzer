"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getUserContextWithRole } from "@/lib/auth";

/**
 * « Corriger plus tard » : les factures listées sont acceptées telles quelles.
 *
 * Passe `pending_review → reviewed`, ce qui les sort de cet écran sans rien modifier
 * de leurs données. C'est volontairement le même statut qu'une facture relue à la main :
 * du point de vue du portefeuille, un humain a vu la liste et l'a laissée passer.
 *
 * Aucune colonne « ignoré » n'est ajoutée : le statut existant porte déjà exactement
 * ce sens, et une seconde notion de « vu » se serait désynchronisée de la première.
 *
 * Réservée au Superviseur, comme la page /corrections qui l'appelle. La garde est ici et
 * pas seulement sur la page : un Server Action est un point d'entrée HTTP à part entière,
 * il ne traverse pas le proxy et son identifiant est lisible dans un chunk `_next/static`
 * — que le matcher exclut. Sans cette ligne, un Membre pouvait basculer en masse des
 * factures de `pending_review` à `reviewed` sans jamais ouvrir l'écran.
 */
export async function dismissCorrections(invoiceIds: string[]): Promise<{ ok: boolean; count: number; error?: string }> {
  const ctx = await getUserContextWithRole("org_supervisor");
  if (!ctx) return { ok: false, count: 0, error: "Non autorisé." };
  if (!invoiceIds.length) return { ok: true, count: 0 };

  const supabase = await createClient();
  // `org_id` explicite en plus de la RLS : l'isolation ne doit pas reposer sur la seule
  // policy, cohérent avec le reste de `lib/data`.
  const { data, error } = await supabase
    .from("invoices")
    .update({ status: "reviewed" })
    .eq("org_id", ctx.orgId)
    .eq("status", "pending_review")
    .in("id", invoiceIds.slice(0, 500))
    .select("id");

  if (error) return { ok: false, count: 0, error: error.message };

  revalidatePath("/corrections");
  return { ok: true, count: data?.length ?? 0 };
}
