import { createClient } from "@/lib/supabase/server";

export interface DateRange {
  /** Première facture du périmètre (YYYY-MM-DD). */
  from: string;
  /** Dernière facture du périmètre (YYYY-MM-DD). */
  to: string;
}

export interface InvoiceScope {
  /** Communes ayant au moins une facture — l'ordre est celui de la table `communes`. */
  communeIds: string[];
  /** Bornes de `facture_date` commune par commune. */
  parCommune: Record<string, DateRange>;
  /** Bornes sur tout le périmètre ; null quand l'organisation n'a aucune facture. */
  global: DateRange | null;
}

/**
 * Ce que les documents couvrent réellement : quelles communes, et sur quelle plage de dates.
 *
 * Sert à deux endroits où proposer le référentiel complet induit en erreur :
 * le sélecteur de commune (34 communes au référentiel, mais seules quelques-unes ont
 * des factures) et les bornes de dates des rapports, qu'on préremplit plutôt que de
 * laisser l'utilisateur deviner la profondeur d'historique dont il dispose.
 *
 * Les factures archivées sont exclues : elles ne sont pas visibles dans Mes documents,
 * elles ne doivent donc pas faire apparaître une commune ni étendre une plage de dates.
 *
 * On lit deux colonnes plutôt qu'une agrégation SQL : c'est le même volume que le
 * `select("site_id")` déjà fait sur ces pages pour restreindre la liste des sites.
 */
export async function getInvoiceScope(orgId: string): Promise<InvoiceScope> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("invoices")
    .select("commune_id, facture_date")
    .eq("org_id", orgId)
    .eq("archived", false)
    .not("facture_date", "is", null);

  if (error || !data) return { communeIds: [], parCommune: {}, global: null };

  const parCommune: Record<string, DateRange> = {};
  let min: string | null = null;
  let max: string | null = null;

  for (const row of data as { commune_id: string | null; facture_date: string }[]) {
    const d = row.facture_date;
    if (!d) continue;
    if (min === null || d < min) min = d;
    if (max === null || d > max) max = d;
    if (!row.commune_id) continue;
    const cur = parCommune[row.commune_id];
    if (!cur) parCommune[row.commune_id] = { from: d, to: d };
    else {
      if (d < cur.from) cur.from = d;
      if (d > cur.to) cur.to = d;
    }
  }

  return {
    communeIds: Object.keys(parCommune),
    parCommune,
    global: min && max ? { from: min, to: max } : null,
  };
}
