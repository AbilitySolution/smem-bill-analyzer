import type { InvoiceExtraction } from "@/lib/anthropic/invoice-schema";
import { diffExtraction, fieldKey, presentFields } from "./diff";

/**
 * Mesure d'une extraction contre une référence validée.
 *
 * `extraction-quality.ts` mesure la précision **en production**, à partir des corrections
 * humaines : c'est de la vraie vérité terrain, mais elle arrive après coup et ne peut rien
 * empêcher. Un changement de prompt part en production sans que personne ne sache s'il
 * améliore ou dégrade quoi que ce soit, et la réponse met des semaines à se former.
 *
 * Ce module ferme la boucle dans l'autre sens : rejouer l'extraction sur un jeu figé de
 * factures dont la version validée est connue, et comparer avant de déployer.
 *
 * La vérité terrain ne vient pas d'un étiquetage manuel : ce sont les factures déjà
 * validées et corrigées par les utilisateurs. Le jeu de référence existait déjà en base,
 * il n'avait jamais été figé.
 *
 * Comparaison déléguée à `diffExtraction`, la même fonction qui journalise les corrections
 * humaines : un écart mesuré ici est exactement ce qu'un relecteur aurait eu à corriger.
 */

/** Une facture de référence : le fichier d'origine et sa version validée. */
export interface GoldenCase {
  invoiceId: string;
  factureNumber: string;
  filePath: string;
  expected: InvoiceExtraction;
}

/**
 * Un écart, avec les deux valeurs.
 *
 * Les conserver n'est pas un confort : un rapport qui n'énumère que des noms de champs
 * ne peut pas être audité. Confronté à « je ne vois aucune erreur sur cette facture », il
 * ne permet ni de confirmer ni d'infirmer — et un outil de mesure qu'on ne peut pas
 * contredire ne mesure rien.
 */
export interface Divergence {
  key: string;
  expected: string | null;
  actual: string | null;
  /** Rang de la ligne pour les tables enfants — deux lignes du même tableau ont la même clé. */
  lineIndex?: number;
}

export interface CaseResult {
  factureNumber: string;
  /** Champs renseignés dans la référence — le dénominateur de ce cas. */
  comparedFields: string[];
  /** Champs dont la valeur diffère de la référence. */
  wrongFields: string[];
  /** Les mêmes écarts, valeurs comprises. Absent sur les résultats produits avant cet ajout. */
  divergences?: Divergence[];
  /** Erreur d'exécution (extraction impossible), auquel cas les listes sont vides. */
  error?: string;
}

export interface FieldScore {
  key: string;
  /** Factures où ce champ avait une valeur de référence. */
  compared: number;
  correct: number;
  /** null si l'échantillon est trop petit pour être honnête. */
  precision: number | null;
}

export interface EvalReport {
  caseCount: number;
  /** Factures rejouées sans le moindre écart. Le vrai indicateur de bout en bout. */
  exactCount: number;
  failedCount: number;
  overallPrecision: number | null;
  fields: FieldScore[];
}

/**
 * Même seuil que `extraction-quality.ts` : sous 5 observations, un taux n'a pas de valeur
 * statistique et afficher « 100 % » sur deux factures induit plus en erreur que se taire.
 */
const MIN_SAMPLE = 5;

/**
 * Compare une extraction candidate à sa référence.
 *
 * Le dénominateur est l'ensemble des champs **renseignés dans la référence** : on ne peut
 * juger la justesse d'un champ que là où il y avait quelque chose à lire. Un champ que la
 * candidate invente alors que la référence est vide compte quand même comme un écart —
 * `diffExtraction` le remonte, et une valeur inventée est une erreur au même titre qu'une
 * valeur fausse.
 */
export function scoreCase(expected: InvoiceExtraction, actual: InvoiceExtraction): {
  comparedFields: string[];
  wrongFields: string[];
  divergences: Divergence[];
} {
  const compared = presentFields(expected);
  const entries = diffExtraction(expected, actual);

  const divergences: Divergence[] = entries.map((d) => ({
    key: fieldKey(d.table_name, d.field_name),
    expected: d.old_value,
    actual: d.new_value,
    ...(d.line_index !== undefined ? { lineIndex: d.line_index } : {}),
  }));

  // Dédupliqué : deux lignes d'un même tableau divergeant sur le même champ ne comptent
  // qu'une fois dans le taux, sinon une facture à dix lignes pèserait dix fois.
  const wrong = new Set(divergences.map((d) => d.key));

  return { comparedFields: [...compared], wrongFields: [...wrong], divergences };
}

export function aggregate(results: CaseResult[]): EvalReport {
  const compared = new Map<string, number>();
  const wrong = new Map<string, number>();

  let exactCount = 0;
  let failedCount = 0;

  for (const r of results) {
    if (r.error) {
      failedCount++;
      continue;
    }
    if (r.wrongFields.length === 0) exactCount++;
    for (const key of r.comparedFields) compared.set(key, (compared.get(key) ?? 0) + 1);
    for (const key of r.wrongFields) wrong.set(key, (wrong.get(key) ?? 0) + 1);
  }

  const fields: FieldScore[] = [...compared.entries()]
    .map(([key, comparedCount]) => {
      const wrongCount = wrong.get(key) ?? 0;
      return {
        key,
        compared: comparedCount,
        correct: comparedCount - wrongCount,
        precision: comparedCount >= MIN_SAMPLE ? 1 - wrongCount / comparedCount : null,
      };
    })
    // Les champs les moins fiables d'abord : c'est là que se prend la décision.
    .sort((a, b) => (a.precision ?? 2) - (b.precision ?? 2) || b.compared - a.compared);

  const measured = fields.filter((f) => f.precision != null);
  const totalCompared = measured.reduce((s, f) => s + f.compared, 0);
  const totalCorrect = measured.reduce((s, f) => s + f.correct, 0);

  return {
    caseCount: results.length,
    exactCount,
    failedCount,
    overallPrecision: totalCompared > 0 ? totalCorrect / totalCompared : null,
    fields,
  };
}

/**
 * Écarts d'un rapport à l'autre.
 *
 * C'est la sortie qui décide d'un déploiement : pas la précision absolue, mais son
 * mouvement depuis la dernière mesure. Un champ qui passe de 98 % à 91 % est un signal
 * fort même si 91 % reste « bon ».
 */
export function compareReports(before: EvalReport, after: EvalReport): {
  key: string;
  before: number;
  after: number;
  delta: number;
}[] {
  const beforeByKey = new Map(before.fields.map((f) => [f.key, f]));
  return after.fields
    .flatMap((f) => {
      const prev = beforeByKey.get(f.key);
      if (prev?.precision == null || f.precision == null) return [];
      return [{ key: f.key, before: prev.precision, after: f.precision, delta: f.precision - prev.precision }];
    })
    .sort((a, b) => a.delta - b.delta);
}
