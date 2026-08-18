import type { SupabaseClient } from "@supabase/supabase-js";
import type { PreviousReading } from "@/lib/anthropic/index-continuity";

type AnySupabaseClient = SupabaseClient;

/**
 * Relevé de clôture de la facture précédente d'un contrat.
 *
 * Alimente `checkIndexContinuity`. Séparé de la règle elle-même pour que celle-ci reste
 * une fonction pure, testable sans base.
 *
 * « Précédente » se lit sur `facture_date` et non sur `created_at` : les imports d'archives
 * arrivent dans le désordre, une facture de 2019 pouvant être déposée après une de 2024.
 * C'est la chronologie du compteur qui compte, pas celle du dépôt.
 */
export async function fetchPreviousReadings(
  supabase: AnySupabaseClient,
  params: {
    orgId: string;
    contractId: string;
    /** Date de la facture en cours de contrôle : on cherche la dernière facture qui la précède. */
    factureDate: string;
    /** Exclut la facture elle-même lors d'un recontrôle après enregistrement. */
    excludeInvoiceId?: string;
  },
): Promise<PreviousReading[]> {
  let query = supabase
    .from("invoices")
    .select("id, facture_number")
    .eq("org_id", params.orgId)
    .eq("contract_id", params.contractId)
    .eq("archived", false)
    // Un duplicata reprend les index de l'original : le retenir comme « précédente »
    // ferait comparer une facture à elle-même.
    .eq("is_duplicata", false)
    .lt("facture_date", params.factureDate)
    .order("facture_date", { ascending: false })
    .limit(1);

  if (params.excludeInvoiceId) query = query.neq("id", params.excludeInvoiceId);

  const { data: prevInvoice, error } = await query.maybeSingle();
  if (error || !prevInvoice) return [];

  const { data: lines, error: linesError } = await supabase
    .from("consumption_periods")
    .select("poste_tarifaire, numero_compteur, nouveau_index, period_end")
    .eq("invoice_id", prevInvoice.id);

  if (linesError || !lines) return [];

  return lines
    .filter((l): l is typeof l & { nouveau_index: number } => l.nouveau_index != null)
    .map((l) => ({
      poste_tarifaire: l.poste_tarifaire,
      numero_compteur: l.numero_compteur,
      nouveau_index: l.nouveau_index,
      period_end: l.period_end,
      facture_number: prevInvoice.facture_number,
    }));
}
