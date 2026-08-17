import { z } from "zod";
import { REFERENTIEL_MARTINIQUE } from "./referentiel-martinique";

/**
 * SCRUM-14 (lot 2) — Validation des entrées de création / modification d'une commune.
 *
 * ⚠️ `nom`, `code_insee`, `latitude` et `longitude` ne sont PAS des entrées utilisateur.
 * Le client n'envoie qu'un `codeInsee`, le serveur résout le reste depuis le référentiel.
 * C'est ce qui empêche un client malveillant d'injecter une commune arbitraire, ou une
 * commune sans coordonnées — la dette du §3.2 du PLAN ne peut pas réapparaître.
 *
 * Restent saisissables : les seules données qui appartiennent réellement au client.
 */

const CODES_REFERENTIEL = new Set<string>(REFERENTIEL_MARTINIQUE.map((c) => c.codeInsee));

const DATE_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Un champ de formulaire vide arrive en `""`. On le ramène à `null` AVANT toute
 * validation : sans ça `z.coerce.number()` transformerait `""` en 0, et « je ne sais pas
 * combien de points lumineux » deviendrait « zéro point lumineux ».
 */
const videVersNull = (v: unknown) => (v === "" || v === null || v === undefined ? null : v);

/** Champ date optionnel : "" et null valent « non renseigné ». */
const dateOptionnelle = z
  .preprocess(
    videVersNull,
    z.union([z.null(), z.string().regex(DATE_ISO, "Date attendue au format AAAA-MM-JJ")]),
  )
  .optional()
  .transform((v) => v ?? null);

/** Entier positif optionnel : "" et null valent « non renseigné ». */
const entierOptionnel = z
  .preprocess(
    videVersNull,
    z.union([z.null(), z.coerce.number().int("Nombre entier attendu").min(0, "Valeur négative impossible")]),
  )
  .optional()
  .transform((v) => v ?? null);

/** Champs métier, communs à la création et à la modification. */
const champsMetier = z.object({
  pointsLumineux: entierOptionnel,
  armoires: entierOptionnel,
  travauxDebut: dateOptionnelle,
  travauxFin: dateOptionnelle,
  travauxEstimes: z.boolean().optional().default(false),
});

/** Une fenêtre de travaux qui se termine avant de commencer n'a pas de sens. */
const fenetreCoherente = <T extends { travauxDebut: string | null; travauxFin: string | null }>(v: T, ctx: z.RefinementCtx) => {
  if (v.travauxDebut && v.travauxFin && v.travauxFin < v.travauxDebut) {
    ctx.addIssue({
      code: "custom",
      path: ["travauxFin"],
      message: "La fin des travaux ne peut pas précéder leur début.",
    });
  }
};

export const creerCommuneSchema = champsMetier
  .extend({
    codeInsee: z
      .string()
      .refine((c) => CODES_REFERENTIEL.has(c), "Cette commune ne fait pas partie du référentiel de la Martinique."),
  })
  .superRefine(fenetreCoherente);

/**
 * Modification : champs métier UNIQUEMENT. `codeInsee` n'y figure pas — une commune ne
 * change pas d'identité, et le `nom` vient du référentiel (D5 du PLAN).
 */
export const modifierCommuneSchema = champsMetier.superRefine(fenetreCoherente);

export type CreerCommuneInput = z.input<typeof creerCommuneSchema>;
export type ModifierCommuneInput = z.input<typeof modifierCommuneSchema>;

/** Premier message d'erreur lisible d'un échec de validation Zod. */
export function premierMessage(erreur: z.ZodError): string {
  return erreur.issues[0]?.message ?? "Données invalides.";
}
