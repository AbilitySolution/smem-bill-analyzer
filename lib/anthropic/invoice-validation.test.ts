import { describe, it, expect } from "vitest";
import { validateInvoice, normalizePosteTarifaire } from "./invoice-validation";
import type { InvoiceExtraction } from "./invoice-schema";

function baseExtraction(overrides: Partial<InvoiceExtraction> = {}): InvoiceExtraction {
  return {
    client: { nom: "Commune de Test", reference_client: null, reference_compte: null, adresse: null },
    contract: {
      contract_number: "12345678901234",
      tarif_type: "BASE",
      espace_livraison: null,
      offre: null,
      service: null,
      puissance_souscrite_kva: 9,
      reglage_protection_a: null,
      type_compteur: null,
      numero_compteur: null,
    },
    invoice: {
      facture_number: "F-2026-001",
      facture_date: "2026-01-15",
      date_limite_paiement: null,
      date_prochain_releve: null,
      date_prochaine_facture: null,
      total_ht: 100,
      tva: 5.4,
      autres_taxes: 2.5,
      total_ttc: 107.9,
      is_duplicata: false,
    },
    commune_hint: null,
    categorie_hint: null,
    fixed_charges: [],
    consumption_lines: [],
    taxes: [],
    precision: {
      facture_number: 0.95,
      facture_date: 0.95,
      total_ht: 0.95,
      tva: 0.95,
      autres_taxes: 0.95,
      total_ttc: 0.95,
      contract_number: 0.95,
      puissance_souscrite_kva: 0.95,
    },
    ...overrides,
  };
}

describe("normalizePosteTarifaire", () => {
  it.each([
    ["Heure P", "HP"],
    ["Heures Pleines", "HP"],
    ["H.P.", "HP"],
    ["Heure Creuse", "HC"],
    ["H.C.", "HC"],
    ["HP Bleu", "HPB"],
    ["HC Bleu", "HCB"],
    ["Base", "BASE"],
    ["BASE", "BASE"],
    ["EJP", "EJP"],
    ["EJP Normal", "EJPN"],
    ["EJP Pointe", "EJPP"],
  ])("normalise %s -> %s", (input, expected) => {
    expect(normalizePosteTarifaire(input)).toBe(expected);
  });

  it("retourne la chaine originale si aucun pattern ne correspond", () => {
    expect(normalizePosteTarifaire("Poste Inconnu XYZ")).toBe("Poste Inconnu XYZ");
  });

  it("gere null/undefined", () => {
    expect(normalizePosteTarifaire(null)).toBe("");
    expect(normalizePosteTarifaire(undefined)).toBe("");
  });
});

describe("validateInvoice", () => {
  it("facture cohérente -> pas d'erreur, isValid true", () => {
    const result = validateInvoice(baseExtraction());
    expect(result.isValid).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("détecte TTC != HT + TVA + autres taxes", () => {
    const result = validateInvoice(baseExtraction({
      invoice: { ...baseExtraction().invoice, total_ht: 100, tva: 5, autres_taxes: 2, total_ttc: 200 },
    }));
    const issue = result.issues.find((i) => i.code === "TTC_MISMATCH");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error"); // écart > 1€
    expect(result.isValid).toBe(false);
  });

  it("petit écart TTC (<1€) -> warning, pas error", () => {
    const result = validateInvoice(baseExtraction({
      invoice: { ...baseExtraction().invoice, total_ht: 100, tva: 5.4, autres_taxes: 2.5, total_ttc: 108.5 },
    }));
    const issue = result.issues.find((i) => i.code === "TTC_MISMATCH");
    expect(issue?.severity).toBe("warning");
    expect(result.isValid).toBe(true);
  });

  it("détecte un montant négatif comme erreur", () => {
    const result = validateInvoice(baseExtraction({
      invoice: { ...baseExtraction().invoice, total_ht: -50, total_ttc: -50 },
    }));
    expect(result.issues.some((i) => i.code === "NEGATIVE_AMOUNT")).toBe(true);
    expect(result.isValid).toBe(false);
  });

  it("détecte un écart ligne consommation (kWh x prix != montant)", () => {
    const result = validateInvoice(baseExtraction({
      consumption_lines: [{
        poste_tarifaire: "BASE", date_debut: "2026-01-01", date_fin: "2026-01-31",
        numero_compteur: null, ancien_index: null, nouveau_index: null, coefficient: 1,
        consommation_kwh: 1000, prix_unitaire_ckwh: 10, montant_eur: 500, index_estime: false,
      }],
    }));
    expect(result.issues.some((i) => i.code === "LINE_AMOUNT_MISMATCH")).toBe(true);
  });

  it("détecte une inversion d'index (ancien > nouveau)", () => {
    const result = validateInvoice(baseExtraction({
      consumption_lines: [{
        poste_tarifaire: "BASE", date_debut: null, date_fin: null,
        numero_compteur: null, ancien_index: 5000, nouveau_index: 1000, coefficient: 1,
        consommation_kwh: 100, prix_unitaire_ckwh: null, montant_eur: 10, index_estime: false,
      }],
    }));
    expect(result.issues.some((i) => i.code === "INDEX_INVERSION")).toBe(true);
  });

  it("détecte une inversion de dates (début > fin)", () => {
    const result = validateInvoice(baseExtraction({
      consumption_lines: [{
        poste_tarifaire: "BASE", date_debut: "2026-06-01", date_fin: "2026-01-01",
        numero_compteur: null, ancien_index: null, nouveau_index: null, coefficient: 1,
        consommation_kwh: 100, prix_unitaire_ckwh: null, montant_eur: 10, index_estime: false,
      }],
    }));
    const issue = result.issues.find((i) => i.code === "DATE_INVERSION");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
    expect(result.isValid).toBe(false);
  });

  it("HP/HC présents mais tarif_type != HPHC -> avertissement", () => {
    const result = validateInvoice(baseExtraction({
      contract: { ...baseExtraction().contract, tarif_type: "BASE" },
      consumption_lines: [
        { poste_tarifaire: "HP", date_debut: null, date_fin: null, numero_compteur: null, ancien_index: null, nouveau_index: null, coefficient: 1, consommation_kwh: 100, prix_unitaire_ckwh: 15, montant_eur: 15, index_estime: false },
        { poste_tarifaire: "HC", date_debut: null, date_fin: null, numero_compteur: null, ancien_index: null, nouveau_index: null, coefficient: 1, consommation_kwh: 100, prix_unitaire_ckwh: 10, montant_eur: 10, index_estime: false },
      ],
    }));
    expect(result.issues.some((i) => i.code === "TARIF_TYPE_MISMATCH")).toBe(true);
  });

  it("HP et HC même prix sur la même période -> avertissement (probable erreur OCR)", () => {
    const result = validateInvoice(baseExtraction({
      contract: { ...baseExtraction().contract, tarif_type: "HPHC" },
      consumption_lines: [
        { poste_tarifaire: "HP", date_debut: "2026-01-01", date_fin: "2026-01-31", numero_compteur: null, ancien_index: null, nouveau_index: null, coefficient: 1, consommation_kwh: 100, prix_unitaire_ckwh: 12, montant_eur: 12, index_estime: false },
        { poste_tarifaire: "HC", date_debut: "2026-01-01", date_fin: "2026-01-31", numero_compteur: null, ancien_index: null, nouveau_index: null, coefficient: 1, consommation_kwh: 100, prix_unitaire_ckwh: 12, montant_eur: 12, index_estime: false },
      ],
    }));
    expect(result.issues.some((i) => i.code === "HPHC_SAME_PRICE")).toBe(true);
  });

  it("faible confiance sur un champ critique -> issue LOW_CONFIDENCE", () => {
    // total_ttc a un signal arithmétique fort (HT+TVA+taxes cohérent) qui compense
    // une faible auto-confiance — pour vraiment déclencher LOW_CONFIDENCE il faut
    // un champ sans filet arithmétique (facture_number) ET un format faible (court).
    const result = validateInvoice(baseExtraction({
      invoice: { ...baseExtraction().invoice, facture_number: "F1" },
      precision: { ...baseExtraction().precision, facture_number: 0.1 },
    }));
    const issue = result.issues.find((i) => i.code === "LOW_CONFIDENCE" && i.field === "precision.facture_number");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error"); // score < 0.4
    expect(result.needsReview).toBe(true);
  });
});
