import type { InvoiceExtraction } from "./invoice-schema";
import { normalizePosteTarifaire, type ValidationIssue } from "./invoice-validation";

/**
 * Continuité des index d'un relevé au suivant.
 *
 * `validateInvoice` ne voit qu'une facture : il vérifie que ses nombres ne se contredisent
 * pas entre eux. Mais un compteur est une série continue — l'index d'ouverture d'une
 * facture est l'index de clôture de la précédente, sur le même contrat, le même poste et
 * le même compteur. C'est une égalité stricte, pas une tendance.
 *
 * C'est le contrôle le plus discriminant du métier, parce qu'il est le seul à voir ce
 * qu'aucune facture ne montre isolément :
 *   - un chiffre transposé dans un index (55 392 lu 55 932) qui reste cohérent avec sa
 *     propre consommation si celle-ci a été mal lue de la même façon ;
 *   - une facture manquante dans la série — le trou apparaît comme un saut d'index sans
 *     facture pour le porter ;
 *   - un compteur attribué au mauvais point de livraison sur un site multi-compteurs ;
 *   - une période rattachée au mauvais contrat.
 *
 * Écrit comme fonction pure sur un relevé précédent fourni par l'appelant : la couche
 * données décide comment le chercher (voir `lib/data/previous-readings.ts`), la règle
 * reste testable sans base.
 */

/** Clôture d'un poste sur la facture précédente du même contrat. */
export interface PreviousReading {
  poste_tarifaire: string;
  numero_compteur: string | null;
  /** Index de clôture relevé sur la facture précédente. */
  nouveau_index: number;
  /** Fin de période de la facture précédente, pour situer l'écart dans le temps. */
  period_end: string | null;
  /** Numéro de la facture précédente, cité dans le message pour que la relecture soit actionnable. */
  facture_number: string;
}

/**
 * Clé d'appariement : poste normalisé + compteur.
 *
 * Le compteur entre dans la clé parce qu'un contrat peut en porter plusieurs (armoires
 * d'éclairage public sur un même contrat). Quand il est absent des deux côtés, le poste
 * seul suffit — c'est le cas courant du bâtiment à compteur unique.
 */
function readingKey(poste: string | null | undefined, compteur: string | null | undefined): string {
  return `${normalizePosteTarifaire(poste)}|${(compteur ?? "").trim().toUpperCase()}`;
}

/**
 * Tolérance sur l'égalité des index.
 *
 * Zéro serait le bon chiffre en théorie. En pratique un relevé peut être arrondi, et sur
 * un poste équipé d'un transformateur une unité d'index vaut `coefficient` kWh — l'écart
 * d'arrondi doit donc être lu à cette échelle. Une unité d'index de battement.
 */
const INDEX_EQUALITY_TOLERANCE = 1;

export function checkIndexContinuity(
  data: InvoiceExtraction,
  previous: PreviousReading[],
): ValidationIssue[] {
  if (previous.length === 0) return [];

  const byKey = new Map<string, PreviousReading>();
  for (const p of previous) {
    byKey.set(readingKey(p.poste_tarifaire, p.numero_compteur), p);
  }

  const issues: ValidationIssue[] = [];

  for (let i = 0; i < data.consumption_lines.length; i++) {
    const line = data.consumption_lines[i];
    if (line.ancien_index == null) continue;

    const prev =
      byKey.get(readingKey(line.poste_tarifaire, line.numero_compteur)) ??
      // Repli : le compteur n'est pas toujours réimprimé d'une facture à l'autre. Un seul
      // poste correspondant sans compteur reste un appariement sûr ; plusieurs, non.
      (() => {
        const poste = normalizePosteTarifaire(line.poste_tarifaire);
        const matches = previous.filter((p) => normalizePosteTarifaire(p.poste_tarifaire) === poste);
        return matches.length === 1 ? matches[0] : undefined;
      })();

    if (!prev) continue;

    const delta = line.ancien_index - prev.nouveau_index;
    if (Math.abs(delta) <= INDEX_EQUALITY_TOLERANCE) continue;

    // Le sens de l'écart change ce qu'il faut aller vérifier, donc le message le dit.
    const cause =
      delta > 0
        ? "facture intermédiaire absente du dossier, ou index mal lu"
        : "index en recul par rapport au relevé précédent — mauvais compteur, mauvais contrat, ou index mal lu";

    issues.push({
      code: "INDEX_DISCONTINUITY",
      severity: "error",
      message: `[${line.poste_tarifaire} #${i + 1}] ancien index ${line.ancien_index} ≠ ${prev.nouveau_index}, clôture de la facture ${prev.facture_number}${prev.period_end ? ` (au ${prev.period_end})` : ""} — écart de ${delta > 0 ? "+" : ""}${delta} : ${cause}`,
      field: `consumption_lines[${i}].ancien_index`,
      expected: prev.nouveau_index,
      actual: line.ancien_index,
      delta,
    });
  }

  return issues;
}
