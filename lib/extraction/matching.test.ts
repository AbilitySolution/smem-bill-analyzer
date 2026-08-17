import { describe, it, expect } from "vitest";
import { normalizeComm, scoreCommune, pickBestCommune, pickBestCommuneScored, COMMUNE_MATCH_THRESHOLD } from "./matching";
import { REFERENTIEL_MARTINIQUE } from "@/lib/communes/referentiel-martinique";

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

  it("développe la ligature œ : Schœlcher matche SCHOELCHER", () => {
    expect(normalizeComm("Schœlcher")).toBe("schoelcher");
    expect(normalizeComm("SCHOELCHER")).toBe(normalizeComm("Schœlcher"));
    expect(scoreCommune("SCHOELCHER", "Schœlcher")).toBe(100);
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

/**
 * SCRUM-14 (lot 4) — Non-régression du matching avec les 34 communes en base.
 *
 * `scoreCommune` renvoie 100 sur simple inclusion de sous-chaîne. Ajouter les 14 communes
 * manquantes crée des ambiguïtés réelles que les 20 seules ne produisaient pas :
 * « Le Marin » face à « Le Marigot », « Rivière-Pilote » et « Rivière-Salée » face à
 * « Grand'Rivière » et « Case-Pilote », et les Saint* avec la neutralisation de genre.
 *
 * Si l'un de ces cas casse, c'est une décision de conception — pas un seuil à bricoler.
 */
describe("pickBestCommuneScored avec les 34 communes de Martinique", () => {
  const TOUTES = REFERENTIEL_MARTINIQUE.map((c, i) => ({ id: String(i), nom: c.nom }));

  const CAS: ReadonlyArray<readonly [string, string]> = [
    ["CASE PILOTE", "Case-Pilote"],
    ["RIVIERE PILOTE", "Rivière-Pilote"],
    ["RIVIERE SALEE", "Rivière-Salée"],
    ["LE MARIN", "Le Marin"],
    ["MARIGOT", "Le Marigot"],
    ["ST PIERRE", "Saint-Pierre"],
    ["ST ESPRIT", "Saint-Esprit"],
    ["STE MARIE", "Sainte-Marie"],
    ["STE ANNE", "Sainte-Anne"],
  ];

  it.each(CAS)("rattache « %s » à %s", (etiquette, attendu) => {
    const best = pickBestCommuneScored([etiquette], TOUTES);
    expect(best, `« ${etiquette} » n'a été rattachée à aucune commune`).not.toBeNull();
    expect(best!.nom).toBe(attendu);
  });

  it("ne laisse aucune ambiguïté : une seule commune atteint le score maximal", () => {
    for (const [etiquette, attendu] of CAS) {
      const scores = TOUTES.map((c) => ({ nom: c.nom, score: scoreCommune(etiquette, c.nom) }));
      const max = Math.max(...scores.map((s) => s.score));
      const exAequo = scores.filter((s) => s.score === max);
      expect(exAequo.map((s) => s.nom), `« ${etiquette} » est ambiguë`).toEqual([attendu]);
    }
  });

  it("rattache Schœlcher malgré la ligature, quelle que soit la graphie de la facture", () => {
    for (const etiquette of ["SCHOELCHER", "Schœlcher", "schoelcher"]) {
      expect(pickBestCommuneScored([etiquette], TOUTES)?.nom, etiquette).toBe("Schœlcher");
    }
  });
});
