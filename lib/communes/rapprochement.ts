import { normalizeComm, meaningfulWords } from "@/lib/extraction/matching";
import { REFERENTIEL_MARTINIQUE, type CommuneReferentiel } from "./referentiel-martinique";

/**
 * SCRUM-14 (lot 1b) — Rapprochement d'un nom de commune en base avec le référentiel.
 *
 * Les 20 communes de l'org SMEM ont été saisies sans tirets ni accents (« Les Trois Ilets »,
 * « Grand Rivière ») et parfois sans article (« Carbet » pour « Le Carbet »). Ce module
 * retrouve l'entrée du référentiel correspondante, pour alimenter le backfill `code_insee`
 * du lot 1c.
 *
 * ⚠️ Usage transitoire. Une fois le backfill fait, la clé de rapprochement est `code_insee`,
 * jamais le nom (§3.3 du PLAN.md).
 *
 * `normalizeComm` est importée telle quelle et non réimplémentée : le rapprochement doit
 * mesurer exactement la normalisation qu'utilise le matching des factures.
 */

/** Nom normalisé privé de ses articles. « Le Carbet » et « Carbet » convergent vers « carbet ». */
export function cleSansArticles(nom: string): string {
  return meaningfulWords(normalizeComm(nom)).join(" ");
}

export interface IndexReferentiel {
  readonly strict: ReadonlyMap<string, CommuneReferentiel>;
  readonly sansArticles: ReadonlyMap<string, CommuneReferentiel>;
}

/**
 * Indexe le référentiel sur deux clés : normalisation stricte, puis normalisation sans
 * articles pour le repli.
 *
 * Lève si deux entrées entrent en collision sur l'une des deux clés — un référentiel
 * ambigu ne doit pas être départagé au hasard, il doit être corrigé.
 */
export function indexerReferentiel(
  referentiel: readonly CommuneReferentiel[] = REFERENTIEL_MARTINIQUE,
): IndexReferentiel {
  const strict = new Map<string, CommuneReferentiel>();
  const sansArticles = new Map<string, CommuneReferentiel>();

  for (const entree of referentiel) {
    const cleStricte = normalizeComm(entree.nom);
    const cleRepli = cleSansArticles(entree.nom);

    const collisionStricte = strict.get(cleStricte);
    if (collisionStricte) {
      throw new Error(
        `Référentiel ambigu : « ${entree.nom} » et « ${collisionStricte.nom} » se normalisent tous deux en « ${cleStricte} ».`,
      );
    }
    const collisionRepli = sansArticles.get(cleRepli);
    if (collisionRepli) {
      throw new Error(
        `Référentiel ambigu sans articles : « ${entree.nom} » et « ${collisionRepli.nom} » donnent tous deux « ${cleRepli} ».`,
      );
    }

    strict.set(cleStricte, entree);
    sansArticles.set(cleRepli, entree);
  }

  return { strict, sansArticles };
}

export type PasseRapprochement = "stricte" | "sans articles";

export interface ResultatRapprochement {
  readonly entree: CommuneReferentiel;
  readonly passe: PasseRapprochement;
}

/**
 * Retrouve l'entrée du référentiel correspondant à un nom en base, ou `null`.
 *
 * Deux passes, la stricte d'abord : on ne retire les articles que si la correspondance
 * exacte a échoué, pour ne pas confondre deux communes qui ne différeraient que par là.
 */
export function rapprocherCommune(
  nomEnBase: string,
  index: IndexReferentiel = indexerReferentiel(),
): ResultatRapprochement | null {
  const stricte = index.strict.get(normalizeComm(nomEnBase));
  if (stricte) return { entree: stricte, passe: "stricte" };

  const repli = index.sansArticles.get(cleSansArticles(nomEnBase));
  if (repli) return { entree: repli, passe: "sans articles" };

  return null;
}
