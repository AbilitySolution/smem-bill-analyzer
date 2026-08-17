import { describe, it, expect } from "vitest";
import { SOCLE_CODES_INSEE, communesDuSocle } from "./socle";
import { REFERENTIEL_MARTINIQUE } from "./referentiel-martinique";

describe("socle attribué à une nouvelle organisation", () => {
  it("compte 20 communes, sans doublon", () => {
    expect(SOCLE_CODES_INSEE).toHaveLength(20);
    expect(new Set(SOCLE_CODES_INSEE).size).toBe(20);
  });

  it("ne référence que des codes du référentiel", () => {
    const codes = new Set<string>(REFERENTIEL_MARTINIQUE.map((c) => c.codeInsee));
    for (const code of SOCLE_CODES_INSEE) {
      expect(codes.has(code), `code ${code} absent du référentiel`).toBe(true);
    }
  });

  it("laisse exactement 14 communes à ajouter", () => {
    expect(REFERENTIEL_MARTINIQUE.length - SOCLE_CODES_INSEE.length).toBe(14);
  });

  it("livre les entrées complètes, triées par nom, avec des coordonnées", () => {
    const socle = communesDuSocle();
    expect(socle).toHaveLength(20);

    const noms = socle.map((c) => c.nom);
    expect(noms).toEqual([...noms].sort((a, b) => a.localeCompare(b, "fr")));

    for (const c of socle) {
      expect(Number.isFinite(c.latitude), c.nom).toBe(true);
      expect(Number.isFinite(c.longitude), c.nom).toBe(true);
    }
  });

  /** Une org neuve n'a pas d'historique : elle reçoit l'orthographe officielle. */
  it("utilise les noms officiels, pas l'orthographe historique du SMEM", () => {
    const noms = communesDuSocle().map((c) => c.nom);
    expect(noms).toContain("Le Carbet");
    expect(noms).not.toContain("Carbet");
    expect(noms).toContain("Les Trois-Îlets");
    expect(noms).not.toContain("Les Trois Ilets");
  });

  it("contient Le Morne-Vert et Bellefontaine, les deux exceptions de numérotation", () => {
    expect(SOCLE_CODES_INSEE).toContain("97233");
    expect(SOCLE_CODES_INSEE).toContain("97234");
  });

  it("n'inclut pas Le Lamentin, qui fait partie des 14 à ajouter", () => {
    expect(SOCLE_CODES_INSEE).not.toContain("97213");
  });
});
