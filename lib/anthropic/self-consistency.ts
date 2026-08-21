import type { InvoiceExtraction } from "./invoice-schema";
import type { ValidationIssue } from "./invoice-validation";
import { diffExtraction, fieldKey, presentFields } from "@/lib/extraction/diff";

/**
 * Accord entre deux lectures indépendantes du même document.
 *
 * Les scores de confiance existants raisonnent sur une seule lecture : cohérence
 * arithmétique, plausibilité du format. Ils ne voient pas l'instabilité — un champ peut
 * être parfaitement bien formé, arithmétiquement muet, et lu différemment à chaque passe.
 *
 * Le commentaire sur la température dans `extraction-request.ts` mesure exactement cela :
 * même au réglage le plus déterministe, une lecture sur dix restait fausse sur un scan
 * difficile. Cette variance est observable — il suffit de lire deux fois et de comparer.
 * Un champ qui diverge entre deux passes est douteux par construction, sans qu'aucune
 * règle métier n'ait à le prédire.
 *
 * Coûteux par nature : à réserver aux documents que les autres signaux jugent déjà fragiles
 * (`reviewLevel` ≠ `auto`), et de préférence en mode batch, où le tarif est réduit de moitié.
 */

export interface ConsistencyReport {
  /** Part des champs renseignés sur lesquels les deux lectures tombent d'accord. */
  agreementRate: number;
  /** Clés `table.colonne` divergentes, dédupliquées. */
  divergentFields: string[];
  issues: ValidationIssue[];
}

/**
 * Sous ce taux d'accord, les deux lectures racontent deux documents différents : ce n'est
 * plus un champ isolé à vérifier mais l'extraction entière qui est suspecte.
 */
const WHOLE_DOCUMENT_SUSPECT_THRESHOLD = 0.9;

export function compareExtractions(a: InvoiceExtraction, b: InvoiceExtraction): ConsistencyReport {
  const divergences = diffExtraction(a, b);

  // Dénominateur : les champs que la première passe a effectivement renseignés. Un champ
  // vide des deux côtés n'est pas un accord, c'est une absence — le compter gonflerait
  // artificiellement le taux.
  const denominator = presentFields(a).size;

  const divergentFields = [
    ...new Set(divergences.map((d) => fieldKey(d.table_name, d.field_name))),
  ];

  const agreementRate =
    denominator === 0 ? 1 : Math.max(0, 1 - divergentFields.length / denominator);

  const issues: ValidationIssue[] = [];

  if (agreementRate < WHOLE_DOCUMENT_SUSPECT_THRESHOLD) {
    issues.push({
      code: "SELF_CONSISTENCY_LOW",
      severity: "error",
      message: `Deux lectures du même document ne concordent que sur ${Math.round(agreementRate * 100)} % des champs (${divergentFields.length} divergences sur ${denominator}) — document probablement illisible ou mal découpé`,
    });
  } else {
    for (const d of divergences) {
      issues.push({
        code: "SELF_CONSISTENCY_DIVERGENCE",
        severity: "warning",
        message: `${fieldKey(d.table_name, d.field_name)} : lu "${d.old_value ?? "∅"}" puis "${d.new_value ?? "∅"}" sur deux passes — valeur instable, à vérifier`,
        field: `${d.table_name}.${d.field_name}`,
      });
    }
  }

  return { agreementRate, divergentFields, issues };
}
