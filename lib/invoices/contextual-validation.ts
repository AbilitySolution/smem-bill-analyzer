import type { SupabaseClient } from "@supabase/supabase-js";
import type { InvoiceExtraction } from "@/lib/anthropic/invoice-schema";
import { summarize, validateInvoice, type ValidationResult } from "@/lib/anthropic/invoice-validation";
import { checkIndexContinuity } from "@/lib/anthropic/index-continuity";
import { checkContractAnchoring, type StoredContractProfile } from "@/lib/extraction/contract-anchoring";
import { fetchPreviousReadings } from "@/lib/data/previous-readings";

type AnySupabaseClient = SupabaseClient;

/**
 * Validation d'une facture **replacée dans l'historique de son contrat**.
 *
 * `validateInvoice` ne voit qu'un document et ne peut donc juger que de sa cohérence
 * interne. Deux des contrôles les plus discriminants demandent de regarder ailleurs :
 *
 *   - la continuité des index d'une facture à la suivante, qui seule détecte une facture
 *     manquante ou un chiffre transposé resté cohérent avec sa propre ligne ;
 *   - l'accord des attributs de contrat avec ce que l'historique affirme.
 *
 * Réunis ici plutôt que dans `validateInvoice`, qui doit rester une fonction pure : c'est
 * ce qui permet de tester les règles sans base, et de les rejouer dans le banc de mesure.
 *
 * Dégradation silencieuse assumée : si le contrat est inconnu ou si les requêtes échouent,
 * on renvoie le verdict local. Une facture ne doit pas devenir impossible à relire parce
 * qu'une lecture d'historique a échoué.
 */
export async function validateInvoiceInContext(
  supabase: AnySupabaseClient,
  extraction: InvoiceExtraction,
  ctx: { orgId: string; excludeInvoiceId?: string },
): Promise<ValidationResult> {
  const local = validateInvoice(extraction);

  const contractNumber = extraction.contract.contract_number;
  if (!contractNumber) return local;

  const { data: contract } = await supabase
    .from("contracts")
    .select("id, tarif_type, puissance_souscrite_kva")
    .eq("org_id", ctx.orgId)
    .eq("contract_number", contractNumber)
    .maybeSingle();

  if (!contract) return local;

  const [previous, invoiceCount] = await Promise.all([
    fetchPreviousReadings(supabase, {
      orgId: ctx.orgId,
      contractId: contract.id,
      factureDate: extraction.invoice.facture_date,
      excludeInvoiceId: ctx.excludeInvoiceId,
    }),
    countContractInvoices(supabase, ctx.orgId, contract.id),
  ]);

  const profile: StoredContractProfile = {
    contract_number: contractNumber,
    tarif_type: contract.tarif_type,
    puissance_souscrite_kva: contract.puissance_souscrite_kva,
    invoiceCount,
  };

  const issues = [
    ...local.issues,
    ...checkIndexContinuity(extraction, previous),
    ...checkContractAnchoring(extraction, profile),
  ];

  // Le verdict est réassemblé, pas rapiécé : ajouter une erreur doit pouvoir faire basculer
  // `isValid` et `reviewLevel`, ce qu'une simple concaténation d'anomalies ne ferait pas.
  return summarize(issues, local.confidence, local.fieldConfidence);
}

async function countContractInvoices(
  supabase: AnySupabaseClient,
  orgId: string,
  contractId: string,
): Promise<number> {
  const { count } = await supabase
    .from("invoices")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("contract_id", contractId)
    .eq("archived", false);
  return count ?? 0;
}
