import { describe, it, expect } from "vitest";
import { creerCommuneSchema, modifierCommuneSchema, premierMessage } from "./validation";

/**
 * Ce qui compte ici n'est pas que Zod fonctionne, mais que le contrat d'entrée reste
 * fermé : le client ne peut décrire QUE le code INSEE et ses champs métier. Si un jour
 * `nom` ou `latitude` redevient acceptable en entrée, ces tests doivent tomber.
 */

const base = { codeInsee: "97213" };

describe("creerCommuneSchema", () => {
  it("accepte un code du référentiel sans aucun champ métier", () => {
    const r = creerCommuneSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.codeInsee).toBe("97213");
      expect(r.data.pointsLumineux).toBeNull();
      expect(r.data.travauxEstimes).toBe(false);
    }
  });

  it("refuse un code absent du référentiel", () => {
    const r = creerCommuneSchema.safeParse({ codeInsee: "97299" });
    expect(r.success).toBe(false);
    if (!r.success) expect(premierMessage(r.error)).toMatch(/référentiel/);
  });

  it("refuse un code de commune d'un autre département", () => {
    expect(creerCommuneSchema.safeParse({ codeInsee: "97101" }).success).toBe(false);
  });

  /** La garantie centrale : le serveur résout nom et coordonnées, le client ne les impose pas. */
  it("ignore nom, latitude et longitude s'ils sont injectés dans l'entrée", () => {
    const r = creerCommuneSchema.safeParse({
      ...base,
      nom: "Commune Pirate",
      latitude: 48.85,
      longitude: 2.35,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).not.toHaveProperty("nom");
      expect(r.data).not.toHaveProperty("latitude");
      expect(r.data).not.toHaveProperty("longitude");
    }
  });

  it("accepte les champs métier valides", () => {
    const r = creerCommuneSchema.safeParse({
      ...base,
      pointsLumineux: 1200,
      armoires: 30,
      travauxDebut: "2020-06-01",
      travauxFin: "2022-06-30",
      travauxEstimes: true,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.pointsLumineux).toBe(1200);
  });

  it("traite la chaîne vide comme « non renseigné »", () => {
    const r = creerCommuneSchema.safeParse({ ...base, pointsLumineux: "", travauxDebut: "" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.pointsLumineux).toBeNull();
      expect(r.data.travauxDebut).toBeNull();
    }
  });

  it("refuse un nombre négatif de points lumineux", () => {
    const r = creerCommuneSchema.safeParse({ ...base, pointsLumineux: -1 });
    expect(r.success).toBe(false);
  });

  it("refuse une fin de travaux antérieure au début", () => {
    const r = creerCommuneSchema.safeParse({
      ...base,
      travauxDebut: "2022-06-30",
      travauxFin: "2020-06-01",
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(premierMessage(r.error)).toMatch(/fin des travaux/i);
  });

  it("accepte des travaux commençant et finissant le même jour", () => {
    const r = creerCommuneSchema.safeParse({
      ...base,
      travauxDebut: "2022-06-30",
      travauxFin: "2022-06-30",
    });
    expect(r.success).toBe(true);
  });

  it("refuse une date mal formée", () => {
    expect(creerCommuneSchema.safeParse({ ...base, travauxDebut: "30/06/2022" }).success).toBe(false);
  });
});

describe("modifierCommuneSchema", () => {
  it("n'accepte pas de changer de commune : codeInsee n'est pas dans la sortie", () => {
    const r = modifierCommuneSchema.safeParse({ codeInsee: "97201", pointsLumineux: 10 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).not.toHaveProperty("codeInsee");
  });

  it("valide toujours la cohérence de la fenêtre de travaux", () => {
    const r = modifierCommuneSchema.safeParse({ travauxDebut: "2023-01-01", travauxFin: "2022-01-01" });
    expect(r.success).toBe(false);
  });
});
