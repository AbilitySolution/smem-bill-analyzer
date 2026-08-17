/**
 * SCRUM-14 — Référentiel des 34 communes de Martinique.
 *
 * Source : Code Officiel Géographique (COG) INSEE, millésime 2026. Vérifié le 2026-08-16
 * contre deux sources officielles concordantes au caractère près :
 *  - https://geo.api.gouv.fr/communes?codeDepartement=972&fields=nom,code,centre&format=json
 *  - https://www.insee.fr/fr/statistiques/fichier/8740222/v_commune_2026.csv
 *
 *  - codeInsee : code officiel. ⚠️ La numérotation du 972 n'est PAS alphabétique :
 *                Le Morne-Vert (97233) et Bellefontaine (97234) ont été créées tardivement
 *                (détachées du Carbet et de Case-Pilote) et numérotées à la fin. Ne jamais
 *                dériver un code d'un rang alphabétique — c'est l'erreur qui a été corrigée ici.
 *  - nom       : champ LIBELLE du COG (forme avec article), orthographe officielle.
 *  - lat/lng   : centroïde du polygone communal renvoyé par geo.api.gouv.fr, arrondi à 4
 *                décimales (~11 m). Suffisant pour la correction météo / longueur de nuit
 *                à l'échelle mensuelle.
 *
 * Ce référentiel n'est PAS affiché dans l'outil : il alimente uniquement le sélecteur
 * d'ajout d'une commune (§3.2bis du PLAN.md). Les communes non créées n'existent pas
 * pour les analyses, la heatmap, les rapports ou le matching de factures.
 *
 * Il ne fait PAS autorité sur l'orthographe des communes déjà en base. Celles-ci gardent
 * leur nom historique (« Les Trois Ilets », « Carbet ») : l'outil n'en a que faire, et le
 * renommer changerait le rattachement des factures. Ce que le référentiel apporte aux
 * communes existantes, ce sont leurs coordonnées et leur code INSEE, rien d'autre.
 *
 * Invariant, garanti par referentiel-martinique.test.ts : 34 entrées, codeInsee unique,
 * nom unique, coordonnées non nulles et dans les bornes de la Martinique.
 *
 * Entrées triées par codeInsee croissant, l'ordre du COG.
 */

export interface CommuneReferentiel {
  readonly codeInsee: string;
  readonly nom: string;
  readonly latitude: number;
  readonly longitude: number;
}

export const REFERENTIEL_MARTINIQUE = [
  { codeInsee: "97201", nom: "L'Ajoupa-Bouillon", latitude: 14.816,   longitude: -61.1305 },
  { codeInsee: "97202", nom: "Les Anses-d'Arlet", latitude: 14.4996,  longitude: -61.0736 },
  { codeInsee: "97203", nom: "Basse-Pointe",      latitude: 14.841,   longitude: -61.1237 },
  { codeInsee: "97204", nom: "Le Carbet",         latitude: 14.7041,  longitude: -61.1583 },
  { codeInsee: "97205", nom: "Case-Pilote",       latitude: 14.6594,  longitude: -61.1297 },
  { codeInsee: "97206", nom: "Le Diamant",        latitude: 14.4787,  longitude: -61.0165 },
  { codeInsee: "97207", nom: "Ducos",             latitude: 14.5785,  longitude: -60.9685 },
  { codeInsee: "97208", nom: "Fonds-Saint-Denis", latitude: 14.7228,  longitude: -61.1207 },
  { codeInsee: "97209", nom: "Fort-de-France",    latitude: 14.6492,  longitude: -61.0686 },
  { codeInsee: "97210", nom: "Le François",       latitude: 14.6093,  longitude: -60.8976 },
  { codeInsee: "97211", nom: "Grand'Rivière",     latitude: 14.847,   longitude: -61.1836 },
  { codeInsee: "97212", nom: "Gros-Morne",        latitude: 14.7084,  longitude: -61.0303 },
  { codeInsee: "97213", nom: "Le Lamentin",       latitude: 14.6231,  longitude: -60.9923 },
  { codeInsee: "97214", nom: "Le Lorrain",        latitude: 14.7995,  longitude: -61.074 },
  { codeInsee: "97215", nom: "Macouba",           latitude: 14.8474,  longitude: -61.1465 },
  { codeInsee: "97216", nom: "Le Marigot",        latitude: 14.7795,  longitude: -61.053 },
  { codeInsee: "97217", nom: "Le Marin",          latitude: 14.4822,  longitude: -60.8589 },
  { codeInsee: "97218", nom: "Le Morne-Rouge",    latitude: 14.7695,  longitude: -61.1217 },
  { codeInsee: "97219", nom: "Le Prêcheur",       latitude: 14.8221,  longitude: -61.1963 },
  { codeInsee: "97220", nom: "Rivière-Pilote",    latitude: 14.5027,  longitude: -60.897 },
  { codeInsee: "97221", nom: "Rivière-Salée",     latitude: 14.5262,  longitude: -60.9623 },
  { codeInsee: "97222", nom: "Le Robert",         latitude: 14.6786,  longitude: -60.9243 },
  { codeInsee: "97223", nom: "Saint-Esprit",      latitude: 14.5617,  longitude: -60.9233 },
  { codeInsee: "97224", nom: "Saint-Joseph",      latitude: 14.6835,  longitude: -61.0407 },
  { codeInsee: "97225", nom: "Saint-Pierre",      latitude: 14.7717,  longitude: -61.1735 },
  { codeInsee: "97226", nom: "Sainte-Anne",       latitude: 14.4314,  longitude: -60.8516 },
  { codeInsee: "97227", nom: "Sainte-Luce",       latitude: 14.4904,  longitude: -60.9467 },
  { codeInsee: "97228", nom: "Sainte-Marie",      latitude: 14.773,   longitude: -61.0084 },
  { codeInsee: "97229", nom: "Schœlcher",         latitude: 14.6518,  longitude: -61.1001 },
  { codeInsee: "97230", nom: "La Trinité",        latitude: 14.7518,  longitude: -60.9469 },
  { codeInsee: "97231", nom: "Les Trois-Îlets",   latitude: 14.5329,  longitude: -61.0376 },
  { codeInsee: "97232", nom: "Le Vauclin",        latitude: 14.542,   longitude: -60.8595 },
  { codeInsee: "97233", nom: "Le Morne-Vert",     latitude: 14.7046,  longitude: -61.1362 },
  { codeInsee: "97234", nom: "Bellefontaine",     latitude: 14.6747,  longitude: -61.146 },
] as const satisfies readonly CommuneReferentiel[];
