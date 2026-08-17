import { REFERENTIEL_MARTINIQUE, type CommuneReferentiel } from "./referentiel-martinique";

/**
 * SCRUM-14 — Socle de communes attribué à une organisation nouvellement provisionnée.
 *
 * Les 20 communes historiques du SMEM. Un nouveau client démarre avec ce socle, puis
 * complète lui-même depuis la page Paramètres parmi les 14 restantes.
 *
 * ⚠️ Contrairement aux 20 lignes déjà en base chez SMEM — qui gardent leur orthographe
 * historique parce que la renommer changerait le rattachement des factures — une
 * organisation neuve n'a aucun historique à préserver. Elle reçoit donc l'orthographe
 * officielle du référentiel : « Le Carbet » et non « Carbet », « Les Trois-Îlets » et non
 * « Les Trois Ilets ».
 */
export const SOCLE_CODES_INSEE: readonly string[] = [
  "97202", // Les Anses-d'Arlet
  "97204", // Le Carbet
  "97205", // Case-Pilote
  "97207", // Ducos
  "97208", // Fonds-Saint-Denis
  "97211", // Grand'Rivière
  "97212", // Gros-Morne
  "97215", // Macouba
  "97216", // Le Marigot
  "97218", // Le Morne-Rouge
  "97219", // Le Prêcheur
  "97222", // Le Robert
  "97223", // Saint-Esprit
  "97226", // Sainte-Anne
  "97228", // Sainte-Marie
  "97230", // La Trinité
  "97231", // Les Trois-Îlets
  "97232", // Le Vauclin
  "97233", // Le Morne-Vert
  "97234", // Bellefontaine
];

/** Les entrées du référentiel correspondant au socle, triées par nom. */
export function communesDuSocle(): CommuneReferentiel[] {
  const codes = new Set(SOCLE_CODES_INSEE);
  const entrees = REFERENTIEL_MARTINIQUE.filter((c) => codes.has(c.codeInsee));

  if (entrees.length !== SOCLE_CODES_INSEE.length) {
    const trouves = new Set<string>(entrees.map((c) => c.codeInsee));
    const manquants = SOCLE_CODES_INSEE.filter((c) => !trouves.has(c));
    throw new Error(`Socle incohérent : code(s) absent(s) du référentiel — ${manquants.join(", ")}`);
  }

  return [...entrees].sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
}
