import { describe, it, expect } from "vitest";
import { normalizeComm, scoreCommune, pickBestCommune, COMMUNE_MATCH_THRESHOLD } from "./matching";

const COMMUNES = [
  { id: "1", nom: "Fonds Saint Denis" },
  { id: "2", nom: "Grand'Rivière" },
  { id: "3", nom: "Le Morne Rouge" },
  { id: "4", nom: "Sainte Marie" },
  { id: "5", nom: "Le Robert" },
];

describe("normalizeComm", () => {
  it("retire accents et ponctuation", () => {
    expect(normalizeComm("Grand'Rivière")).toBe("grand riviere");
  });

  it("développe les abréviations st / ste", () => {
    expect(normalizeComm("St-Denis")).toBe("saint denis");
    expect(normalizeComm("Ste Marie")).toBe("saint marie");
  });

  it("neutralise le genre : sainte devient saint", () => {
    expect(normalizeComm("Sainte Marie")).toBe(normalizeComm("Saint Marie"));
  });
});

describe("scoreCommune", () => {
  it("donne 100 sur correspondance exacte, casse et accents ignorés", () => {
    expect(scoreCommune("FONDS SAINT DENIS", "Fonds Saint Denis")).toBe(100);
  });

  it("donne 100 quand le nom est inclus dans une adresse", () => {
    expect(scoreCommune("12 rue des Écoles, 97250 Fonds Saint Denis", "Fonds Saint Denis")).toBe(100);
  });

  it("ignore les mots vides dans le recouvrement", () => {
    // "Le" est un mot vide : "Morne Rouge" doit suffire à identifier "Le Morne Rouge".
    expect(scoreCommune("Morne Rouge", "Le Morne Rouge")).toBe(100);
  });

  it("renvoie 0 sur deux communes sans rapport", () => {
    expect(scoreCommune("Le Robert", "Sainte Marie")).toBe(0);
  });
});

describe("pickBestCommune", () => {
  it("retrouve la commune malgré une abréviation", () => {
    expect(pickBestCommune(["FONDS ST DENIS"], COMMUNES)?.id).toBe("1");
  });

  it("retrouve la commune malgré une variation de genre", () => {
    expect(pickBestCommune(["Ste-Marie"], COMMUNES)?.id).toBe("4");
  });

  it("retrouve la commune depuis une adresse complète", () => {
    expect(pickBestCommune(["Mairie, 97218 Grand Riviere"], COMMUNES)?.id).toBe("2");
  });

  it("ne propose rien plutôt que de se tromper quand rien ne correspond", () => {
    expect(pickBestCommune(["Paris 15e"], COMMUNES)).toBeNull();
  });

  it("ne propose rien sur une liste de communes vide", () => {
    expect(pickBestCommune(["Le Robert"], [])).toBeNull();
  });

  it("retient le meilleur candidat parmi plusieurs textes", () => {
    // Le premier candidat ne matche rien, le second identifie la commune.
    expect(pickBestCommune(["Client inconnu", "Le Robert"], COMMUNES)?.id).toBe("5");
  });

  it("applique le seuil quand aucune chaîne n'est incluse dans l'autre", () => {
    // Un seul mot significatif en commun ("fonds") sur les trois du nom de commune
    // → 0.33, sous le seuil. Ni l'un ni l'autre n'est une sous-chaîne.
    const score = scoreCommune("Fonds Ecoles Batiment", "Fonds Saint Denis");
    expect(score).toBeLessThan(COMMUNE_MATCH_THRESHOLD);
    expect(pickBestCommune(["Fonds Ecoles Batiment"], COMMUNES)).toBeNull();
  });

  it("un fragment inclus dans le nom suffit — c'est la règle de sous-chaîne", () => {
    // Comportement délibéré : il fait matcher une adresse qui contient la commune.
    // Contrepartie assumée : un fragment court et ambigu matche aussi.
    expect(scoreCommune("Denis", "Fonds Saint Denis")).toBe(100);
  });
});
