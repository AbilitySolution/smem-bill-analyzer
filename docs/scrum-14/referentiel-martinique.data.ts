/**
 * SCRUM-14 — Référentiel des 34 communes de Martinique.
 *
 * ⚠️ FICHIER DE TRAVAIL — à déplacer vers `lib/communes/referentiel-martinique.ts`
 *    au lot 1a, après vérification des `codeInsee` contre le COG INSEE officiel.
 *
 * Source des données :
 *  - codeInsee  : codification INSEE des DOM, séquence alphabétique 97201→97234. À VÉRIFIER.
 *  - nom        : orthographe officielle (tirets, apostrophes, accents).
 *  - lat/lng    : centroïdes approximatifs, même précision que la migration
 *                 20260728000000_communes-latlng.sql. Suffisant pour la correction
 *                 météo / longueur de nuit à l'échelle mensuelle.
 *
 * Ce référentiel n'est PAS affiché dans l'outil : il alimente uniquement le sélecteur
 * d'ajout d'une commune (§3.2bis du PLAN.md). Les communes non créées n'existent pas
 * pour les analyses, la heatmap, les rapports ou le matching de factures.
 *
 * Invariant : 34 entrées, codeInsee unique, nom unique, coordonnées non nulles.
 */

export interface CommuneReferentiel {
  readonly codeInsee: string;
  readonly nom: string;
  readonly latitude: number;
  readonly longitude: number;
}

export const REFERENTIEL_MARTINIQUE = [
  { codeInsee: "97201", nom: "L'Ajoupa-Bouillon", latitude: 14.8333, longitude: -61.1333 },
  { codeInsee: "97202", nom: "Les Anses-d'Arlet", latitude: 14.4967, longitude: -61.08 },
  { codeInsee: "97203", nom: "Basse-Pointe", latitude: 14.8667, longitude: -61.1 },
  { codeInsee: "97204", nom: "Bellefontaine", latitude: 14.6667, longitude: -61.1667 },
  { codeInsee: "97205", nom: "Le Carbet", latitude: 14.7167, longitude: -61.1667 },
  { codeInsee: "97206", nom: "Case-Pilote", latitude: 14.6167, longitude: -61.2167 },
  { codeInsee: "97207", nom: "Le Diamant", latitude: 14.4833, longitude: -61.0333 },
  { codeInsee: "97208", nom: "Ducos", latitude: 14.6833, longitude: -60.9833 },
  { codeInsee: "97209", nom: "Fonds-Saint-Denis", latitude: 14.7333, longitude: -61.1167 },
  { codeInsee: "97210", nom: "Fort-de-France", latitude: 14.6, longitude: -61.0667 },
  { codeInsee: "97211", nom: "Le François", latitude: 14.6167, longitude: -60.9 },
  { codeInsee: "97212", nom: "Grand'Rivière", latitude: 14.8667, longitude: -61.2167 },
  { codeInsee: "97213", nom: "Gros-Morne", latitude: 14.7667, longitude: -61.0167 },
  { codeInsee: "97214", nom: "Le Lamentin", latitude: 14.61, longitude: -61.0 },
  { codeInsee: "97215", nom: "Le Lorrain", latitude: 14.8333, longitude: -61.05 },
  { codeInsee: "97216", nom: "Macouba", latitude: 14.8667, longitude: -61.1167 },
  { codeInsee: "97217", nom: "Le Marigot", latitude: 14.8667, longitude: -61.0167 },
  { codeInsee: "97218", nom: "Le Marin", latitude: 14.4667, longitude: -60.8667 },
  { codeInsee: "97219", nom: "Le Morne-Rouge", latitude: 14.7833, longitude: -61.1333 },
  { codeInsee: "97220", nom: "Le Morne-Vert", latitude: 14.7167, longitude: -61.1333 },
  { codeInsee: "97221", nom: "Le Prêcheur", latitude: 14.8, longitude: -61.2333 },
  { codeInsee: "97222", nom: "Rivière-Pilote", latitude: 14.4833, longitude: -60.9 },
  { codeInsee: "97223", nom: "Rivière-Salée", latitude: 14.5333, longitude: -60.9667 },
  { codeInsee: "97224", nom: "Le Robert", latitude: 14.6767, longitude: -60.9367 },
  { codeInsee: "97225", nom: "Saint-Esprit", latitude: 14.5533, longitude: -60.9433 },
  { codeInsee: "97226", nom: "Saint-Joseph", latitude: 14.6667, longitude: -61.0333 },
  { codeInsee: "97227", nom: "Saint-Pierre", latitude: 14.75, longitude: -61.1667 },
  { codeInsee: "97228", nom: "Sainte-Anne", latitude: 14.4333, longitude: -60.8667 },
  { codeInsee: "97229", nom: "Sainte-Luce", latitude: 14.4667, longitude: -60.9333 },
  { codeInsee: "97230", nom: "Sainte-Marie", latitude: 14.7833, longitude: -60.9833 },
  { codeInsee: "97231", nom: "Schœlcher", latitude: 14.6167, longitude: -61.1 },
  { codeInsee: "97232", nom: "La Trinité", latitude: 14.7333, longitude: -60.9667 },
  { codeInsee: "97233", nom: "Les Trois-Îlets", latitude: 14.5367, longitude: -61.0367 },
  { codeInsee: "97234", nom: "Le Vauclin", latitude: 14.55, longitude: -60.85 },
] as const satisfies readonly CommuneReferentiel[];

/**
 * Les 20 communes déjà présentes dans l'org SMEM au 2026-08-16, avec leur nom
 * EXACT en base (orthographe historique, sans tirets ni accents pour certaines).
 *
 * Sert uniquement au script de vérification du lot 1b. Ne pas utiliser en runtime :
 * une fois le backfill `code_insee` fait, le rapprochement se fait par code INSEE.
 *
 * ⚠️ Ne PAS renommer ces communes en base : `scoreCommune` matche sur le `nom`,
 *    un renommage changerait le rattachement des factures futures (§3.4 du PLAN.md).
 */
export const NOMS_EN_BASE_2026_08: Readonly<Record<string, string>> = {
  "97202": "Les Anses d'Arlet",
  "97204": "Bellefontaine",
  "97205": "Carbet",
  "97206": "Case Pilote",
  "97208": "Ducos",
  "97209": "Fonds Saint Denis",
  "97212": "Grand Rivière",
  "97213": "Gros Morne",
  "97216": "Macouba",
  "97217": "Le Marigot",
  "97219": "Le Morne Rouge",
  "97220": "Le Morne Vert",
  "97221": "Le Prêcheur",
  "97224": "Le Robert",
  "97225": "Saint Esprit",
  "97228": "Sainte Anne",
  "97230": "Sainte Marie",
  "97232": "La Trinité",
  "97233": "Les Trois Ilets",
  "97234": "Le Vauclin",
};
