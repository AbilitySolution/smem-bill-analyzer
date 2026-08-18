import type { InvoiceExtraction } from "@/lib/anthropic/invoice-schema";
import type { ValidationIssue } from "@/lib/anthropic/invoice-validation";

/**
 * Ancrage des attributs de contrat sur l'historique.
 *
 * `tarif_type`, `puissance_souscrite_kva` et le nom du client ne sont pas des données de
 * facture : ce sont des attributs du contrat, stables d'une facture à l'autre. Les
 * redéduire à chaque document, c'est refaire à chaque fois un pari déjà gagné — et perdre
 * l'information la plus utile qui soit : le désaccord entre ce qui vient d'être lu et ce
 * que trente factures précédentes affirment.
 *
 * `matching.ts` applique déjà ce principe à la commune et au site. Ici on l'étend aux
 * attributs du contrat, avec la même règle : le modèle propose, l'historique arbitre.
 *
 * Aucune valeur n'est écrasée automatiquement. Une divergence est un signal à faire
 * remonter en relecture, pas une correction à appliquer en silence : un contrat peut
 * réellement changer de tarif ou de puissance, et c'est précisément l'événement métier
 * qu'on veut voir plutôt que masquer.
 */

/** Ce que l'historique du contrat affirme, et sur combien de factures. */
export interface StoredContractProfile {
  contract_number: string;
  tarif_type: string | null;
  puissance_souscrite_kva: number | null;
  /** Nombre de factures déjà enregistrées sur ce contrat. Fait la différence entre un
   *  profil établi et une seule facture qui pourrait elle-même être mal lue. */
  invoiceCount: number;
}

/**
 * En dessous, l'historique n'est pas plus fiable que la lecture en cours : on se tait.
 * Deux factures concordantes suffisent à donner du poids à un attribut ; une seule ne
 * prouve rien, elle a pu être extraite de travers.
 */
const MIN_HISTORY = 2;

export function checkContractAnchoring(
  data: InvoiceExtraction,
  stored: StoredContractProfile | null,
): ValidationIssue[] {
  if (!stored || stored.invoiceCount < MIN_HISTORY) return [];

  const issues: ValidationIssue[] = [];
  const { contract } = data;
  const basis = `${stored.invoiceCount} factures du contrat ${stored.contract_number}`;

  // --- tarif_type ---
  if (stored.tarif_type != null) {
    if (contract.tarif_type == null) {
      // L'historique sait ce que cette lecture n'a pas su déduire : ce n'est pas un
      // conflit, c'est un trou comblable. Signalé pour que la relecture le pré-remplisse.
      issues.push({
        code: "CONTRACT_ANCHOR_MISSING",
        severity: "warning",
        message: `tarif_type non déduit alors que ${basis} portent "${stored.tarif_type}"`,
        field: "contract.tarif_type",
      });
    } else if (contract.tarif_type !== stored.tarif_type) {
      issues.push({
        code: "CONTRACT_ANCHOR_CONFLICT",
        severity: "warning",
        message: `tarif_type lu "${contract.tarif_type}" alors que ${basis} portent "${stored.tarif_type}" — changement contractuel réel ou erreur de lecture`,
        field: "contract.tarif_type",
      });
    }
  }

  // --- puissance souscrite ---
  // Une puissance se renégocie, mais par paliers francs (6, 9, 12, 36 kVA…). Un écart
  // d'un dixième trahit une lecture, pas un avenant : le seuil relatif distingue les deux.
  if (stored.puissance_souscrite_kva != null) {
    const read = contract.puissance_souscrite_kva;
    if (read == null) {
      issues.push({
        code: "CONTRACT_ANCHOR_MISSING",
        severity: "warning",
        message: `puissance souscrite non lue alors que ${basis} portent ${stored.puissance_souscrite_kva} kVA`,
        field: "contract.puissance_souscrite_kva",
      });
    } else if (Math.abs(read - stored.puissance_souscrite_kva) > stored.puissance_souscrite_kva * 0.02) {
      issues.push({
        code: "CONTRACT_ANCHOR_CONFLICT",
        severity: "warning",
        message: `puissance souscrite lue ${read} kVA alors que ${basis} portent ${stored.puissance_souscrite_kva} kVA`,
        field: "contract.puissance_souscrite_kva",
        expected: stored.puissance_souscrite_kva,
        actual: read,
        delta: read - stored.puissance_souscrite_kva,
      });
    }
  }

  return issues;
}
