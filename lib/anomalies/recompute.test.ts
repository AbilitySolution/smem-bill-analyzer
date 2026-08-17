import { describe, it, expect } from "vitest";
import { computePortfolioAnomalies, type AnomalyInvoiceInput, type AnomalyLineInput } from "./recompute";

function invoice(overrides: Partial<AnomalyInvoiceInput> & { id: string }): AnomalyInvoiceInput {
  return {
    siteId: "site-1",
    categorie: "batiment",
    factureDate: "2024-01-15",
    totalTtc: 100,
    isDuplicata: false,
    lines: [],
    ...overrides,
  };
}

/** Facture d'un mois de janvier (30 jours de période) — kWh/jour = kwh / 30. */
function january(id: string, siteId: string, year: number, kwh: number): AnomalyInvoiceInput {
  const line: AnomalyLineInput = {
    periodStart: `${year}-01-01`,
    periodEnd: `${year}-01-31`,
    kwh,
    montantEur: kwh / 10,
  };
  return invoice({ id, siteId, factureDate: `${year}-02-01`, lines: [line] });
}

describe("computePortfolioAnomalies — coût kWh vs médiane", () => {
  it("facture au tarif habituel -> pas d'anomalie cout_kwh", () => {
    const invoices = [
      invoice({ id: "a", lines: [{ periodStart: null, periodEnd: null, kwh: 1000, montantEur: 100 }] }), // 10 c€/kWh
      invoice({ id: "b", lines: [{ periodStart: null, periodEnd: null, kwh: 1000, montantEur: 105 }] }), // 10.5 c€/kWh
      invoice({ id: "c", lines: [{ periodStart: null, periodEnd: null, kwh: 1000, montantEur: 95 }] }),  // 9.5 c€/kWh
    ];
    const anomalies = computePortfolioAnomalies(invoices);
    expect(anomalies.filter((a) => a.type === "cout_kwh")).toHaveLength(0);
  });

  it("coût très supérieur à la médiane -> anomalie high avec valueEur = surcoût estimé", () => {
    const invoices = [
      invoice({ id: "a", lines: [{ periodStart: null, periodEnd: null, kwh: 1000, montantEur: 100 }] }), // 10 c€/kWh
      invoice({ id: "b", lines: [{ periodStart: null, periodEnd: null, kwh: 1000, montantEur: 100 }] }), // 10 c€/kWh
      invoice({ id: "c", lines: [{ periodStart: null, periodEnd: null, kwh: 500, montantEur: 200 }] }),  // 40 c€/kWh -> ratio 4
    ];
    const anomalies = computePortfolioAnomalies(invoices);
    const found = anomalies.find((a) => a.type === "cout_kwh" && a.invoiceId === "c");
    expect(found).toBeDefined();
    expect(found?.severity).toBe("high");
    expect(found?.detectedValue).toBeCloseTo(150, 5); // (40-10)/100 * 500
  });

  it("segmente la médiane par catégorie — un site éclairage public au tarif normal n'est PAS comparé à des bâtiments plus chers", () => {
    const invoices = [
      invoice({ id: "b1", categorie: "batiment", lines: [{ periodStart: null, periodEnd: null, kwh: 1000, montantEur: 400 }] }),
      invoice({ id: "b2", categorie: "batiment", lines: [{ periodStart: null, periodEnd: null, kwh: 1000, montantEur: 420 }] }),
      invoice({ id: "e1", categorie: "eclairage_public", lines: [{ periodStart: null, periodEnd: null, kwh: 1000, montantEur: 100 }] }),
      invoice({ id: "e2", categorie: "eclairage_public", lines: [{ periodStart: null, periodEnd: null, kwh: 1000, montantEur: 105 }] }),
      invoice({ id: "e3", categorie: "eclairage_public", lines: [{ periodStart: null, periodEnd: null, kwh: 1000, montantEur: 95 }] }),
    ];
    const anomalies = computePortfolioAnomalies(invoices);
    expect(anomalies.filter((a) => a.type === "cout_kwh")).toHaveLength(0);
  });

  it("un coût unitaire BAS ne produit plus aucune anomalie", () => {
    // Règle `cout_kwh_bas` retirée : un prix bas n'est pas une anomalie de facture.
    const invoices = [
      invoice({ id: "a", lines: [{ periodStart: null, periodEnd: null, kwh: 1000, montantEur: 100 }] }), // 10 c€/kWh
      invoice({ id: "b", lines: [{ periodStart: null, periodEnd: null, kwh: 1000, montantEur: 100 }] }), // 10 c€/kWh
      invoice({ id: "c", lines: [{ periodStart: null, periodEnd: null, kwh: 1000, montantEur: 20 }] }),  // 2 c€/kWh -> ratio 0,2
    ];
    const anomalies = computePortfolioAnomalies(invoices);
    expect(anomalies).toHaveLength(0);
  });
});

describe("computePortfolioAnomalies — consommation anormale (écart robuste)", () => {
  it("hausse franche vs même saison historique -> anomalie de gravité haute", () => {
    const invoices = [
      january("h1", "A", 2019, 300),
      january("h2", "A", 2020, 310),
      january("h3", "A", 2021, 290),
      january("h4", "A", 2022, 305),
      january("h5", "A", 2023, 295),
      january("target", "A", 2024, 600), // 20 kWh/j vs référence 10
    ];
    const spike = computePortfolioAnomalies(invoices)
      .find((a) => a.type === "consumption_spike" && a.invoiceId === "target");
    expect(spike).toBeDefined();
    expect(spike?.severity).toBe("high");
    expect(spike?.description).toContain("hausse");
    expect(spike?.description).toContain("même saison");
  });

  it("baisse franche -> anomalie décrite comme une baisse", () => {
    const invoices = [
      january("h1", "A", 2019, 3000),
      january("h2", "A", 2020, 3100),
      january("h3", "A", 2021, 2900),
      january("h4", "A", 2022, 3050),
      january("h5", "A", 2023, 2950),
      january("target", "A", 2024, 900),
    ];
    const spike = computePortfolioAnomalies(invoices)
      .find((a) => a.type === "consumption_spike" && a.invoiceId === "target");
    expect(spike).toBeDefined();
    expect(spike?.description).toContain("baisse");
  });

  it("LE cas qui justifie l'écart robuste : même dérive relative, seul le site régulier alerte", () => {
    // Deux sites dévient exactement de +50 % par rapport à leur propre médiane.
    // Sur un site parfaitement régulier, +50 % est un événement — il doit alerter.
    // Sur un site qui varie déjà du simple au quadruple, +50 % est le quotidien —
    // alerter serait un faux positif. Un seuil relatif fixe les traitait à l'identique
    // et marquait les deux : c'est ce qui produisait 160 alertes sur 261 factures.
    const invoices = [
      // Site régulier : toujours 300 kWh (10 kWh/j)
      january("r1", "REGULIER", 2019, 300),
      january("r2", "REGULIER", 2020, 300),
      january("r3", "REGULIER", 2021, 300),
      january("r4", "REGULIER", 2022, 300),
      january("r5", "REGULIER", 2023, 300),
      january("regulier-cible", "REGULIER", 2024, 450), // +50 % vs médiane
      // Site erratique : 150 / 450 / 240 / 600 / 360 kWh — médiane 360
      january("e1", "ERRATIQUE", 2019, 150),
      january("e2", "ERRATIQUE", 2020, 450),
      january("e3", "ERRATIQUE", 2021, 240),
      january("e4", "ERRATIQUE", 2022, 600),
      january("e5", "ERRATIQUE", 2023, 360),
      january("erratique-cible", "ERRATIQUE", 2024, 540), // +50 % vs médiane
    ];
    const spikes = computePortfolioAnomalies(invoices).filter((a) => a.type === "consumption_spike");
    expect(spikes.map((s) => s.invoiceId)).toContain("regulier-cible");
    expect(spikes.map((s) => s.invoiceId)).not.toContain("erratique-cible");
  });

  it("variation minime sur un site parfaitement régulier -> pas d'alerte (plancher de dispersion)", () => {
    // Historique strictement identique => MAD nul. Sans plancher, l'écart serait infini
    // et le moindre frémissement deviendrait une alerte de gravité maximale.
    const invoices = [
      january("h1", "D", 2019, 300),
      january("h2", "D", 2020, 300),
      january("h3", "D", 2021, 300),
      january("h4", "D", 2022, 300),
      january("h5", "D", 2023, 300),
      january("target", "D", 2024, 303), // +1 %
    ];
    const spikes = computePortfolioAnomalies(invoices).filter((a) => a.type === "consumption_spike");
    expect(spikes).toHaveLength(0);
  });

  it("variation saisonnière normale (été vs hiver) -> pas d'anomalie", () => {
    const july = (id: string, year: number, kwh: number) => invoice({
      id, siteId: "B", factureDate: `${year}-08-01`,
      lines: [{ periodStart: `${year}-07-01`, periodEnd: `${year}-07-31`, kwh, montantEur: kwh / 10 }],
    });
    const invoices = [
      january("w1", "B", 2020, 300), january("w2", "B", 2021, 310),
      january("w3", "B", 2022, 290), january("w4", "B", 2023, 305),
      july("s1", 2019, 600), july("s2", 2020, 620), july("s3", 2021, 610), july("s4", 2022, 605),
      july("target", 2023, 615), // cohérent avec les étés précédents
    ];
    const anomalies = computePortfolioAnomalies(invoices);
    expect(anomalies.find((a) => a.type === "consumption_spike" && a.invoiceId === "target")).toBeUndefined();
  });

  it("historique insuffisant (3 factures) -> pas d'anomalie", () => {
    const invoices = [
      january("h1", "C", 2021, 300),
      january("h2", "C", 2022, 310),
      january("h3", "C", 2023, 290),
      january("target", "C", 2024, 1200),
    ];
    expect(computePortfolioAnomalies(invoices).filter((a) => a.type === "consumption_spike")).toHaveLength(0);
  });

  it("périodes de durées trop différentes -> écartées de la référence", () => {
    // Historique en mois pleins, cible sur 6 mois : ramenées au jour, ces grandeurs ne
    // décrivent pas le même régime (lissage, saisonnalité interne, régularisations).
    const invoices = [
      january("h1", "E", 2019, 300), january("h2", "E", 2020, 310),
      january("h3", "E", 2021, 290), january("h4", "E", 2022, 305), january("h5", "E", 2023, 295),
      invoice({
        id: "target", siteId: "E", factureDate: "2024-07-01",
        lines: [{ periodStart: "2024-01-01", periodEnd: "2024-06-30", kwh: 3600, montantEur: 360 }],
      }),
    ];
    expect(computePortfolioAnomalies(invoices).filter((a) => a.type === "consumption_spike")).toHaveLength(0);
  });

  it("volume négligeable -> pas d'alerte même sur un écart relatif énorme", () => {
    const invoices = [
      january("h1", "F", 2019, 30), january("h2", "F", 2020, 31),
      january("h3", "F", 2021, 29), january("h4", "F", 2022, 30), january("h5", "F", 2023, 30),
      january("target", "F", 2024, 90), // ×3, mais 90 kWh : sans portée métier
    ];
    expect(computePortfolioAnomalies(invoices).filter((a) => a.type === "consumption_spike")).toHaveLength(0);
  });
});

describe("computePortfolioAnomalies — règles retirées", () => {
  it("facture réelle à 0 kWh -> plus aucune anomalie (conso_manquante retirée)", () => {
    const anomalies = computePortfolioAnomalies([invoice({ id: "a", isDuplicata: false, lines: [] })]);
    expect(anomalies).toHaveLength(0);
  });

  it("aucun type retiré n'est jamais émis", () => {
    const invoices = [
      invoice({ id: "a", isDuplicata: false, lines: [] }),
      invoice({ id: "b", lines: [{ periodStart: null, periodEnd: null, kwh: 1000, montantEur: 100 }] }),
      invoice({ id: "c", lines: [{ periodStart: null, periodEnd: null, kwh: 1000, montantEur: 10 }] }),
      january("d", "Z", 2023, 300),
    ];
    const types = new Set(computePortfolioAnomalies(invoices).map((a) => a.type));
    expect(types.has("cout_kwh_bas" as never)).toBe(false);
    expect(types.has("conso_manquante" as never)).toBe(false);
  });
});
