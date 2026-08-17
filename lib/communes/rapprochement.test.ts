import { describe, it, expect } from "vitest";
import { indexerReferentiel, rapprocherCommune, cleSansArticles } from "./rapprochement";
import { REFERENTIEL_MARTINIQUE } from "./referentiel-martinique";

/**
 * Le script `scripts/check-communes-referentiel.ts` valide le rapprochement contre la vraie
 * base. Ces tests valident la même logique sans accès réseau, pour qu'une modification du
 * référentiel qui casserait un appariement échoue en CI et pas six mois plus tard.
 *
 * Ce qui est en jeu n'est PAS l'orthographe : les communes gardent leur nom historique en
 * base. C'est l'attribution du bon code INSEE — donc des bonnes coordonnées — à chacune.
 */

/**
 * Les 20 communes de l'org SMEM au 2026-08-16 : nom EXACT en base -> code INSEE attendu.
 * Jeu de test, volontairement figé ici plutôt qu'exporté depuis le référentiel : c'est un
 * instantané d'une base à un instant donné, pas une donnée de référence.
 */
const COMMUNES_EN_BASE: ReadonlyArray<readonly [string, string]> = [
  ["Bellefontaine", "97234"],
  ["Carbet", "97204"],
  ["Case Pilote", "97205"],
  ["Ducos", "97207"],
  ["Fonds Saint Denis", "97208"],
  ["Grand Rivière", "97211"],
  ["Gros Morne", "97212"],
  ["La Trinité", "97230"],
  ["Le Marigot", "97216"],
  ["Le Morne Rouge", "97218"],
  ["Le Morne Vert", "97233"],
  ["Le Prêcheur", "97219"],
  ["Le Robert", "97222"],
  ["Le Vauclin", "97232"],
  ["Les Anses d'Arlet", "97202"],
  ["Les Trois Ilets", "97231"],
  ["Macouba", "97215"],
  ["Saint Esprit", "97223"],
  ["Sainte Anne", "97226"],
  ["Sainte Marie", "97228"],
];

describe("indexerReferentiel", () => {
  it("indexe les 34 entrées sans collision, sur les deux clés", () => {
    const index = indexerReferentiel();
    expect(index.strict.size).toBe(34);
    expect(index.sansArticles.size).toBe(34);
  });

  it("refuse un référentiel où deux entrées se normalisent pareil", () => {
    expect(() =>
      indexerReferentiel([
        { codeInsee: "97299", nom: "Sainte-Marie", latitude: 14.7, longitude: -61 },
        { codeInsee: "97298", nom: "Saint Marie", latitude: 14.7, longitude: -61 },
      ]),
    ).toThrow(/ambigu/);
  });

  it("refuse un référentiel ambigu une fois les articles retirés", () => {
    expect(() =>
      indexerReferentiel([
        { codeInsee: "97299", nom: "Le Carbet", latitude: 14.7, longitude: -61 },
        { codeInsee: "97298", nom: "Carbet", latitude: 14.7, longitude: -61 },
      ]),
    ).toThrow(/ambigu sans articles/);
  });
});

describe("cleSansArticles", () => {
  it("fait converger « Le Carbet » et « Carbet »", () => {
    expect(cleSansArticles("Le Carbet")).toBe(cleSansArticles("Carbet"));
  });

  it("ne fait pas converger deux communes réellement distinctes", () => {
    expect(cleSansArticles("Le Marin")).not.toBe(cleSansArticles("Le Marigot"));
    expect(cleSansArticles("Rivière-Pilote")).not.toBe(cleSansArticles("Case-Pilote"));
    expect(cleSansArticles("Rivière-Salée")).not.toBe(cleSansArticles("Grand'Rivière"));
  });
});

describe("rapprocherCommune", () => {
  const index = indexerReferentiel();

  /**
   * Le cœur du lot 1b : chacun des 20 noms réellement en base doit retrouver son entrée,
   * malgré tirets, accents, apostrophes, article absent et neutralisation de genre — et
   * aucune entrée ne doit être réclamée deux fois, sans quoi deux communes hériteraient du
   * même code INSEE et donc des mêmes coordonnées.
   */
  it("apparie les 20 communes de l'org SMEM sans doublon", () => {
    const reclames = new Map<string, string>();

    for (const [nomEnBase, codeAttendu] of COMMUNES_EN_BASE) {
      const resultat = rapprocherCommune(nomEnBase, index);
      expect(resultat, `« ${nomEnBase} » non appariée`).not.toBeNull();
      expect(resultat!.entree.codeInsee, `« ${nomEnBase} »`).toBe(codeAttendu);

      const deja = reclames.get(codeAttendu);
      expect(deja, `${codeAttendu} déjà réclamé par « ${deja} »`).toBeUndefined();
      reclames.set(codeAttendu, nomEnBase);
    }

    expect(reclames.size).toBe(20);
  });

  it("n'a besoin du repli que pour « Carbet », privé de son article en base", () => {
    const passes = COMMUNES_EN_BASE.map(([nom]) => rapprocherCommune(nom, index)!.passe);
    expect(passes.filter((p) => p === "stricte")).toHaveLength(19);
    expect(passes.filter((p) => p === "sans articles")).toHaveLength(1);

    expect(rapprocherCommune("Carbet", index)).toEqual({
      entree: REFERENTIEL_MARTINIQUE.find((c) => c.codeInsee === "97204"),
      passe: "sans articles",
    });
  });

  it("ne confond pas les Saint* malgré la neutralisation de genre de normalizeComm", () => {
    expect(rapprocherCommune("Sainte Marie", index)?.entree.nom).toBe("Sainte-Marie");
    expect(rapprocherCommune("Sainte Anne", index)?.entree.nom).toBe("Sainte-Anne");
    expect(rapprocherCommune("Saint Esprit", index)?.entree.nom).toBe("Saint-Esprit");
    expect(rapprocherCommune("Saint Joseph", index)?.entree.nom).toBe("Saint-Joseph");
    expect(rapprocherCommune("Saint Pierre", index)?.entree.nom).toBe("Saint-Pierre");
  });

  it("retourne null sur une commune hors référentiel", () => {
    expect(rapprocherCommune("Pointe-à-Pitre", index)).toBeNull();
    expect(rapprocherCommune("", index)).toBeNull();
  });
});
