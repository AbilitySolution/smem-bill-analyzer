import { describe, it, expect } from "vitest";
import { aggregate, compareReports, scoreCase, type CaseResult } from "./eval";
import type { InvoiceExtraction } from "@/lib/anthropic/invoice-schema";

function extraction(overrides: Partial<InvoiceExtraction> = {}): InvoiceExtraction {
  return {
    client: { nom: "Commune de Test", reference_client: null, reference_compte: null, adresse: null },
    contract: {
      contract_number: "12345678901234", tarif_type: "BASE", espace_livraison: null, offre: null,
      service: null, puissance_souscrite_kva: 9, reglage_protection_a: null, type_compteur: null,
      numero_compteur: null,
    },
    invoice: {
      facture_number: "F-2026-001", facture_date: "2026-01-15", date_limite_paiement: null,
      date_prochain_releve: null, date_prochaine_facture: null, total_ht: 100, tva: 5.4,
      autres_taxes: 2.5, total_ttc: 107.9, is_duplicata: false,
    },
    commune_hint: null, categorie_hint: null,
    fixed_charges: [], consumption_lines: [], taxes: [], precision: {},
    ...overrides,
  };
}

const result = (o: Partial<CaseResult> = {}): CaseResult => ({
  factureNumber: "F", comparedFields: ["invoices.total_ttc"], wrongFields: [], ...o,
});

describe("scoreCase", () => {
  it("extraction identique -> aucun écart", () => {
    const { wrongFields, comparedFields } = scoreCase(extraction(), extraction());
    expect(wrongFields).toHaveLength(0);
    expect(comparedFields.length).toBeGreaterThan(0);
  });

  it("relève le champ divergent", () => {
    const { wrongFields } = scoreCase(
      extraction(),
      extraction({ invoice: { ...extraction().invoice, total_ttc: 999 } }),
    );
    expect(wrongFields).toContain("invoices.total_ttc");
    expect(wrongFields).toHaveLength(1);
  });

  // Le dénominateur est ce que la référence contenait : on ne peut juger la justesse d'un
  // champ que là où il y avait quelque chose à lire.
  it("ne compte pas les champs absents de la référence dans le dénominateur", () => {
    const { comparedFields } = scoreCase(
      extraction({ invoice: { ...extraction().invoice, date_limite_paiement: null } }),
      extraction(),
    );
    expect(comparedFields).not.toContain("invoices.date_limite_paiement");
  });
});

describe("aggregate", () => {
  it("compte les factures sans le moindre écart", () => {
    const r = aggregate([result(), result(), result({ wrongFields: ["invoices.total_ttc"] })]);
    expect(r.exactCount).toBe(2);
    expect(r.caseCount).toBe(3);
  });

  it("isole les échecs d'exécution du calcul de précision", () => {
    const r = aggregate([result(), result({ error: "téléchargement impossible" })]);
    expect(r.failedCount).toBe(1);
    expect(r.exactCount).toBe(1);
  });

  // Même seuil que `extraction-quality.ts` : afficher « 100 % » sur deux observations
  // induit plus en erreur que ne rien afficher.
  it("se tait sous 5 observations", () => {
    const r = aggregate([result(), result()]);
    expect(r.fields[0].precision).toBeNull();
    expect(r.overallPrecision).toBeNull();
  });

  it("calcule la précision au-delà du seuil", () => {
    const rs = [...Array(9).fill(null).map(() => result()), result({ wrongFields: ["invoices.total_ttc"] })];
    const r = aggregate(rs);
    expect(r.fields[0].precision).toBeCloseTo(0.9);
  });

  it("classe les champs les moins fiables en premier", () => {
    const rs = Array.from({ length: 10 }, (_, i) =>
      result({
        comparedFields: ["invoices.total_ttc", "invoices.facture_number"],
        wrongFields: i < 5 ? ["invoices.facture_number"] : [],
      }),
    );
    expect(aggregate(rs).fields[0].key).toBe("invoices.facture_number");
  });
});

describe("compareReports", () => {
  it("remonte les régressions en tête", () => {
    const before = aggregate(Array.from({ length: 10 }, () => result()));
    const after = aggregate(
      Array.from({ length: 10 }, (_, i) => result({ wrongFields: i < 3 ? ["invoices.total_ttc"] : [] })),
    );
    const deltas = compareReports(before, after);
    expect(deltas[0].key).toBe("invoices.total_ttc");
    expect(deltas[0].delta).toBeCloseTo(-0.3);
  });

  it("ignore un champ dont l'échantillon est trop petit d'un côté", () => {
    const before = aggregate([result(), result()]);
    const after = aggregate(Array.from({ length: 10 }, () => result()));
    expect(compareReports(before, after)).toHaveLength(0);
  });
});
