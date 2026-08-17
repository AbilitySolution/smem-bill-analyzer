import { describe, it, expect } from "vitest";
import { diffExtraction, diffInvoiceSnapshot, type InvoiceSnapshot } from "./diff";
import type { InvoiceExtraction } from "@/lib/anthropic/invoice-schema";

function base(): InvoiceExtraction {
  return {
    client: { nom: "Mairie", reference_client: "C1", reference_compte: "A1", adresse: "1 rue X" },
    contract: {
      contract_number: "CT-1", tarif_type: "HPHC", espace_livraison: "EL", offre: null,
      service: null, puissance_souscrite_kva: 36, reglage_protection_a: null,
      type_compteur: null, numero_compteur: null,
    },
    invoice: {
      facture_number: "F-1", facture_date: "2026-01-10", date_limite_paiement: null,
      date_prochain_releve: null, date_prochaine_facture: null,
      total_ht: 100, tva: 20, autres_taxes: 0, total_ttc: 120, is_duplicata: false,
    },
    commune_hint: "Carbet",
    categorie_hint: "batiment",
    fixed_charges: [{ libelle: "Abonnement", date_debut: "2026-01-01", date_fin: "2026-01-31", tarif_kva_an: 12, montant_eur: 10 }],
    consumption_lines: [{
      poste_tarifaire: "HP", date_debut: "2026-01-01", date_fin: "2026-01-31", numero_compteur: null,
      ancien_index: 100, nouveau_index: 200, coefficient: 1, consommation_kwh: 100,
      prix_unitaire_ckwh: 12, montant_eur: 12, index_estime: false,
    }],
    taxes: [{ libelle: "TVA", date_debut: null, date_fin: null, assiette: 100, taux: "20%", taux_numeric: 20, taux_unit: "percent", montant_eur: 20 }],
  } as InvoiceExtraction;
}

describe("diffExtraction", () => {
  it("ne renvoie rien quand rien n'a changé", () => {
    expect(diffExtraction(base(), base())).toEqual([]);
  });

  it("détecte une correction sur l'en-tête de facture", () => {
    const edited = base();
    edited.invoice.total_ttc = 130;
    const diffs = diffExtraction(base(), edited);
    expect(diffs).toEqual([
      { table_name: "invoices", field_name: "total_ttc", old_value: "120", new_value: "130" },
    ]);
  });

  it("mappe date_debut/date_fin vers les noms de colonnes en base", () => {
    const edited = base();
    edited.consumption_lines[0].date_debut = "2026-01-02";
    const diffs = diffExtraction(base(), edited);
    expect(diffs).toEqual([{
      table_name: "consumption_periods", field_name: "period_start",
      old_value: "2026-01-01", new_value: "2026-01-02", line_index: 0,
    }]);
  });

  it("compte un champ que l'IA a manqué et que l'humain a rempli", () => {
    const original = base();
    original.contract.numero_compteur = null;
    const edited = base();
    edited.contract.numero_compteur = "CPT-9";
    const diffs = diffExtraction(original, edited);
    expect(diffs).toContainEqual({
      table_name: "contracts", field_name: "numero_compteur", old_value: null, new_value: "CPT-9",
    });
  });

  it("traite null, undefined et chaîne vide comme équivalents", () => {
    const original = base();
    original.client.adresse = null;
    const edited = base();
    edited.client.adresse = "";
    expect(diffExtraction(original, edited)).toEqual([]);
  });

  it("route fixed_charges et taxes vers invoice_charges", () => {
    const edited = base();
    edited.fixed_charges[0].montant_eur = 11;
    edited.taxes[0].montant_eur = 21;
    const diffs = diffExtraction(base(), edited);
    expect(diffs.every((d) => d.table_name === "invoice_charges")).toBe(true);
    expect(diffs).toHaveLength(2);
  });

  it("ignore les lignes ajoutées ou supprimées (pas des corrections de champ)", () => {
    const edited = base();
    edited.consumption_lines.push({ ...base().consumption_lines[0], poste_tarifaire: "HC" });
    expect(diffExtraction(base(), edited)).toEqual([]);
  });

  it("détecte un changement de catégorie", () => {
    const edited = base();
    edited.categorie_hint = "eclairage_public";
    const diffs = diffExtraction(base(), edited);
    expect(diffs).toContainEqual({
      table_name: "invoices", field_name: "categorie",
      old_value: "batiment", new_value: "eclairage_public",
    });
  });
});

function snapshot(): InvoiceSnapshot {
  return {
    // Colonnes techniques incluses volontairement : le diff doit les ignorer.
    invoice: {
      id: "inv-1", org_id: "org-1", created_at: "2026-01-01T00:00:00Z",
      facture_number: "F-1", facture_date: "2026-01-10", date_limite_paiement: null,
      total_ht: 100, tva: 20, autres_taxes: 0, total_ttc: 120,
      is_duplicata: false, categorie: "batiment",
    },
    client: { id: "cli-1", nom: "Mairie", reference_client: "C1", reference_compte: "A1", adresse: "1 rue X" },
    contract: { id: "con-1", contract_number: "CT-1", pdl: "PDL1", tarif_type: "HPHC", puissance_souscrite_kva: 36 },
    consumption: [{
      id: "cp-1", invoice_id: "inv-1",
      poste_tarifaire: "HP", period_start: "2026-01-01", period_end: "2026-01-31",
      consommation_kwh: 100, prix_unitaire_ckwh: 12, montant_eur: 12,
    }],
    charges: [{ id: "ch-1", invoice_id: "inv-1", category: "fixed", libelle: "Abonnement", montant_eur: 10 }],
  };
}

describe("diffInvoiceSnapshot", () => {
  it("ne renvoie rien quand rien n'a changé", () => {
    expect(diffInvoiceSnapshot(snapshot(), snapshot())).toEqual([]);
  });

  it("ignore les colonnes techniques", () => {
    const after = snapshot();
    after.invoice.id = "autre";
    after.invoice.created_at = "2026-06-01T00:00:00Z";
    expect(diffInvoiceSnapshot(snapshot(), after)).toEqual([]);
  });

  it("détecte une correction de montant", () => {
    const after = snapshot();
    after.invoice.total_ttc = 130;
    expect(diffInvoiceSnapshot(snapshot(), after)).toEqual([
      { table_name: "invoices", field_name: "total_ttc", old_value: "120", new_value: "130" },
    ]);
  });

  it("apparie les lignes enfants par clé métier, pas par position", () => {
    const before = snapshot();
    before.consumption = [
      { poste_tarifaire: "HP", period_start: "2026-01-01", consommation_kwh: 100 },
      { poste_tarifaire: "HC", period_start: "2026-01-01", consommation_kwh: 50 },
    ];
    const after = snapshot();
    // Ordre inversé + une correction sur HC : seule la correction doit ressortir.
    after.consumption = [
      { poste_tarifaire: "HC", period_start: "2026-01-01", consommation_kwh: 55 },
      { poste_tarifaire: "HP", period_start: "2026-01-01", consommation_kwh: 100 },
    ];
    expect(diffInvoiceSnapshot(before, after)).toEqual([
      { table_name: "consumption_periods", field_name: "consommation_kwh", old_value: "50", new_value: "55", line_index: 0 },
    ]);
  });

  it("ne compte pas une ligne ajoutée comme une correction de champ", () => {
    const after = snapshot();
    after.consumption = [...after.consumption, { poste_tarifaire: "HC", period_start: "2026-02-01", consommation_kwh: 40 }];
    expect(diffInvoiceSnapshot(snapshot(), after)).toEqual([]);
  });

  it("traite null, undefined et chaîne vide comme équivalents", () => {
    const after = snapshot();
    after.invoice.date_limite_paiement = "";
    expect(diffInvoiceSnapshot(snapshot(), after)).toEqual([]);
  });
});
