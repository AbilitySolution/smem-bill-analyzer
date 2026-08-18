import { describe, it, expect } from "vitest";
import { checkIndexContinuity, type PreviousReading } from "./index-continuity";
import type { InvoiceExtraction } from "./invoice-schema";

function line(overrides: Partial<InvoiceExtraction["consumption_lines"][number]> = {}) {
  return {
    poste_tarifaire: "BASE",
    date_debut: "2026-02-01",
    date_fin: "2026-02-28",
    numero_compteur: null,
    ancien_index: 1000,
    nouveau_index: 1200,
    coefficient: 1,
    consommation_kwh: 200,
    prix_unitaire_ckwh: 15,
    montant_eur: 30,
    index_estime: false,
    ...overrides,
  };
}

function extraction(lines: InvoiceExtraction["consumption_lines"]): InvoiceExtraction {
  return {
    client: { nom: "Commune de Test", reference_client: null, reference_compte: null, adresse: null },
    contract: {
      contract_number: "12345678901234", tarif_type: "BASE", espace_livraison: null, offre: null,
      service: null, puissance_souscrite_kva: 9, reglage_protection_a: null, type_compteur: null,
      numero_compteur: null,
    },
    invoice: {
      facture_number: "F-2026-002", facture_date: "2026-03-01", date_limite_paiement: null,
      date_prochain_releve: null, date_prochaine_facture: null, total_ht: 100, tva: 5.4,
      autres_taxes: 2.5, total_ttc: 107.9, is_duplicata: false,
    },
    commune_hint: null, categorie_hint: null,
    fixed_charges: [], consumption_lines: lines, taxes: [], precision: {},
  };
}

const prev = (o: Partial<PreviousReading> = {}): PreviousReading => ({
  poste_tarifaire: "BASE",
  numero_compteur: null,
  nouveau_index: 1000,
  period_end: "2026-01-31",
  facture_number: "F-2026-001",
  ...o,
});

describe("checkIndexContinuity", () => {
  it("série continue -> aucun signalement", () => {
    expect(checkIndexContinuity(extraction([line()]), [prev()])).toHaveLength(0);
  });

  it("pas d'historique -> aucun signalement", () => {
    expect(checkIndexContinuity(extraction([line()]), [])).toHaveLength(0);
  });

  it("saut d'index vers le haut -> erreur (facture intermédiaire absente)", () => {
    const issues = checkIndexContinuity(extraction([line({ ancien_index: 1500 })]), [prev()]);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("INDEX_DISCONTINUITY");
    expect(issues[0].severity).toBe("error");
    expect(issues[0].delta).toBe(500);
    expect(issues[0].message).toContain("F-2026-001");
  });

  it("index en recul par rapport au relevé précédent -> erreur", () => {
    const issues = checkIndexContinuity(extraction([line({ ancien_index: 800 })]), [prev()]);
    expect(issues[0].delta).toBe(-200);
    expect(issues[0].message).toContain("recul");
  });

  it("une unité d'écart passe (arrondi de relevé)", () => {
    expect(checkIndexContinuity(extraction([line({ ancien_index: 1001 })]), [prev()])).toHaveLength(0);
  });

  // Le poste seul ne suffit pas à apparier quand un contrat porte plusieurs compteurs :
  // c'est exactement le cas que ce contrôle doit attraper, pas provoquer.
  it("apparie sur le compteur quand un contrat en porte plusieurs", () => {
    const previous = [
      prev({ numero_compteur: "CPT-A", nouveau_index: 1000 }),
      prev({ numero_compteur: "CPT-B", nouveau_index: 5000 }),
    ];
    const ok = checkIndexContinuity(extraction([line({ numero_compteur: "CPT-B", ancien_index: 5000 })]), previous);
    expect(ok).toHaveLength(0);

    const swapped = checkIndexContinuity(extraction([line({ numero_compteur: "CPT-B", ancien_index: 1000 })]), previous);
    expect(swapped).toHaveLength(1);
  });

  it("compteur absent et plusieurs postes candidats -> pas d'appariement hasardeux", () => {
    const previous = [
      prev({ numero_compteur: "CPT-A", nouveau_index: 1000 }),
      prev({ numero_compteur: "CPT-B", nouveau_index: 5000 }),
    ];
    expect(checkIndexContinuity(extraction([line({ ancien_index: 9999 })]), previous)).toHaveLength(0);
  });

  it("normalise le poste avant appariement (Heures Pleines -> HP)", () => {
    const issues = checkIndexContinuity(
      extraction([line({ poste_tarifaire: "Heures Pleines", ancien_index: 1500 })]),
      [prev({ poste_tarifaire: "HP" })],
    );
    expect(issues).toHaveLength(1);
  });

  it("ancien_index absent -> rien à comparer", () => {
    expect(checkIndexContinuity(extraction([line({ ancien_index: null })]), [prev()])).toHaveLength(0);
  });
});
