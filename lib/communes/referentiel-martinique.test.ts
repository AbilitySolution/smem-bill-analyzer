import { describe, it, expect } from "vitest";
import { REFERENTIEL_MARTINIQUE } from "./referentiel-martinique";

/**
 * Tests de garde sur les données, pas sur du code : le référentiel est figé et vérifié
 * contre le COG INSEE 2026. Ces tests existent pour qu'une modification hâtive du fichier
 * échoue bruyamment plutôt que de corrompre silencieusement le rapprochement des factures.
 */

// Bornes géographiques de la Martinique, volontairement larges (§ Lot 1a du PLAN).
const LAT_MIN = 14.3, LAT_MAX = 15.0;
const LNG_MIN = -61.3, LNG_MAX = -60.7;

describe("REFERENTIEL_MARTINIQUE", () => {
  it("contient exactement les 34 communes de Martinique", () => {
    expect(REFERENTIEL_MARTINIQUE).toHaveLength(34);
  });

  it("n'a aucun codeInsee en double", () => {
    const codes = REFERENTIEL_MARTINIQUE.map((c) => c.codeInsee);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("n'a aucun nom en double", () => {
    const noms = REFERENTIEL_MARTINIQUE.map((c) => c.nom);
    expect(new Set(noms).size).toBe(noms.length);
  });

  it("n'a que des codeInsee du département 972", () => {
    for (const c of REFERENTIEL_MARTINIQUE) {
      expect(c.codeInsee, c.nom).toMatch(/^972\d{2}$/);
    }
  });

  it("n'a aucune coordonnée nulle, undefined ou NaN", () => {
    for (const c of REFERENTIEL_MARTINIQUE) {
      expect(c.latitude, `latitude de ${c.nom}`).toEqual(expect.any(Number));
      expect(c.longitude, `longitude de ${c.nom}`).toEqual(expect.any(Number));
      expect(Number.isFinite(c.latitude), `latitude de ${c.nom}`).toBe(true);
      expect(Number.isFinite(c.longitude), `longitude de ${c.nom}`).toBe(true);
    }
  });

  it("place les 34 communes dans les bornes de la Martinique", () => {
    for (const c of REFERENTIEL_MARTINIQUE) {
      expect(c.latitude, `latitude de ${c.nom}`).toBeGreaterThanOrEqual(LAT_MIN);
      expect(c.latitude, `latitude de ${c.nom}`).toBeLessThanOrEqual(LAT_MAX);
      expect(c.longitude, `longitude de ${c.nom}`).toBeGreaterThanOrEqual(LNG_MIN);
      expect(c.longitude, `longitude de ${c.nom}`).toBeLessThanOrEqual(LNG_MAX);
    }
  });

  /**
   * Garde anti-régression sur l'erreur corrigée au lot 1a : la numérotation du COG
   * n'est pas alphabétique. Si quelqu'un « range » le fichier par ordre alphabétique
   * en réattribuant les codes, ce test tombe.
   */
  it("respecte les deux exceptions de numérotation du COG", () => {
    const parCode = new Map(REFERENTIEL_MARTINIQUE.map((c) => [c.codeInsee, c.nom]));
    expect(parCode.get("97233")).toBe("Le Morne-Vert");
    expect(parCode.get("97234")).toBe("Bellefontaine");
    expect(parCode.get("97204")).toBe("Le Carbet");
    expect(parCode.get("97205")).toBe("Case-Pilote");
  });
});
