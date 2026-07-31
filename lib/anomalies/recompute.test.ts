import { describe, it, expect } from "vitest";
import { computePortfolioAnomalies, type AnomalyInvoiceInput } from "./recompute";

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

  it("segmente la médiane par catégorie — P2 : un site éclairage public au tarif normal n'est PAS comparé à des bâtiments plus chers", () => {
    const invoices = [
      // Bâtiments : tarif élevé (HPHC gros contrat, normal pour cette catégorie)
      invoice({ id: "b1", categorie: "batiment", lines: [{ periodStart: null, periodEnd: null, kwh: 1000, montantEur: 400 }] }), // 40 c€/kWh
      invoice({ id: "b2", categorie: "batiment", lines: [{ periodStart: null, periodEnd: null, kwh: 1000, montantEur: 420 }] }), // 42 c€/kWh
      // Éclairage public : tarif bas normal pour cette catégorie, cohérent entre eux
      invoice({ id: "e1", categorie: "eclairage_public", lines: [{ periodStart: null, periodEnd: null, kwh: 1000, montantEur: 100 }] }), // 10 c€/kWh
      invoice({ id: "e2", categorie: "eclairage_public", lines: [{ periodStart: null, periodEnd: null, kwh: 1000, montantEur: 105 }] }), // 10.5 c€/kWh
      invoice({ id: "e3", categorie: "eclairage_public", lines: [{ periodStart: null, periodEnd: null, kwh: 1000, montantEur: 95 }] }),  // 9.5 c€/kWh
    ];
    const anomalies = computePortfolioAnomalies(invoices);
    // Si la médiane n'était pas segmentée par catégorie, la médiane globale (~40)
    // ferait passer TOUTES les factures éclairage public pour anormalement basses,
    // et pas les bâtiments (qui sont proches de cette médiane globale par hasard).
    // Avec la segmentation, aucune des deux catégories n'est anormale en interne.
    expect(anomalies.filter((a) => a.type === "cout_kwh" || a.type === "cout_kwh_bas")).toHaveLength(0);
  });
});

describe("computePortfolioAnomalies — pic de consommation saisonnier", () => {
  it("hausse franche vs même saison historique -> anomalie", () => {
    const invoices = [
      // 3 factures historiques Q1 (janvier-mars), ~10 kWh/j, site A
      invoice({ id: "h1", siteId: "A", factureDate: "2021-02-01", lines: [{ periodStart: "2021-01-01", periodEnd: "2021-01-31", kwh: 300, montantEur: 30 }] }),
      invoice({ id: "h2", siteId: "A", factureDate: "2022-02-01", lines: [{ periodStart: "2022-01-01", periodEnd: "2022-01-31", kwh: 310, montantEur: 31 }] }),
      invoice({ id: "h3", siteId: "A", factureDate: "2023-02-01", lines: [{ periodStart: "2023-01-01", periodEnd: "2023-01-31", kwh: 290, montantEur: 29 }] }),
      // Facture cible, même saison (Q1), consommation quasi doublée
      invoice({ id: "target", siteId: "A", factureDate: "2024-02-01", lines: [{ periodStart: "2024-01-01", periodEnd: "2024-01-31", kwh: 600, montantEur: 60 }] }),
    ];
    const anomalies = computePortfolioAnomalies(invoices);
    const spike = anomalies.find((a) => a.type === "consumption_spike" && a.invoiceId === "target");
    expect(spike).toBeDefined();
    expect(spike?.severity).toBe("high"); // ~94% de hausse > 80%
    expect(spike?.description).toContain("hausse");
  });

  it("variation saisonnière normale (hiver vs été) -> PAS d'anomalie si comparée à la bonne saison — P1", () => {
    // Site avec conso été (Q3, ~20 kWh/j) et hiver (Q1, ~10 kWh/j) historiquement stables.
    const invoices = [
      invoice({ id: "w1", siteId: "B", factureDate: "2021-02-01", lines: [{ periodStart: "2021-01-01", periodEnd: "2021-01-31", kwh: 300, montantEur: 30 }] }),
      invoice({ id: "w2", siteId: "B", factureDate: "2022-02-01", lines: [{ periodStart: "2022-01-01", periodEnd: "2022-01-31", kwh: 310, montantEur: 31 }] }),
      invoice({ id: "s1", siteId: "B", factureDate: "2021-08-01", lines: [{ periodStart: "2021-07-01", periodEnd: "2021-07-31", kwh: 600, montantEur: 60 }] }),
      invoice({ id: "s2", siteId: "B", factureDate: "2022-08-01", lines: [{ periodStart: "2022-07-01", periodEnd: "2022-07-31", kwh: 620, montantEur: 62 }] }),
      // Cible : été 2023, conso cohérente avec les étés précédents (~20 kWh/j)
      invoice({ id: "target", siteId: "B", factureDate: "2023-08-01", lines: [{ periodStart: "2023-07-01", periodEnd: "2023-07-31", kwh: 610, montantEur: 61 }] }),
    ];
    const anomalies = computePortfolioAnomalies(invoices);
    expect(anomalies.find((a) => a.type === "consumption_spike" && a.invoiceId === "target")).toBeUndefined();
  });

  it("historique insuffisant -> pas d'anomalie (pas de faux positif sur 1 seule facture passée)", () => {
    const invoices = [
      invoice({ id: "h1", siteId: "C", factureDate: "2023-02-01", lines: [{ periodStart: "2023-01-01", periodEnd: "2023-01-31", kwh: 300, montantEur: 30 }] }),
      invoice({ id: "target", siteId: "C", factureDate: "2024-02-01", lines: [{ periodStart: "2024-01-01", periodEnd: "2024-01-31", kwh: 900, montantEur: 90 }] }),
    ];
    const anomalies = computePortfolioAnomalies(invoices);
    expect(anomalies.filter((a) => a.type === "consumption_spike")).toHaveLength(0);
  });
});

describe("computePortfolioAnomalies — consommation manquante", () => {
  it("facture réelle à 0 kWh -> anomalie", () => {
    const invoices = [invoice({ id: "a", isDuplicata: false, lines: [] })];
    const anomalies = computePortfolioAnomalies(invoices);
    expect(anomalies.some((a) => a.type === "conso_manquante" && a.invoiceId === "a")).toBe(true);
  });

  it("duplicata à 0 kWh -> pas d'anomalie (normal pour un duplicata)", () => {
    const invoices = [invoice({ id: "a", isDuplicata: true, lines: [] })];
    const anomalies = computePortfolioAnomalies(invoices);
    expect(anomalies.some((a) => a.type === "conso_manquante")).toBe(false);
  });
});
