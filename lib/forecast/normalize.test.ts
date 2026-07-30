import { describe, it, expect } from "vitest";
import { computeInvoiceRates, weightedAverageRate, historicalSpan } from "./normalize";

describe("computeInvoiceRates", () => {
  it("groupe les lignes par facture et calcule le débit kWh/jour", () => {
    const rows = [
      { invoice_id: "a", period_start: "2026-01-01", period_end: "2026-01-31", consommation_kwh: 300 },
      { invoice_id: "a", period_start: "2026-01-01", period_end: "2026-01-31", consommation_kwh: 0 },
    ];
    const rates = computeInvoiceRates(rows);
    expect(rates).toHaveLength(1);
    expect(rates[0].invoiceId).toBe("a");
    expect(rates[0].days).toBe(30);
    expect(rates[0].kwhPerDay).toBeCloseTo(10, 5); // 300 kWh / 30 jours
  });

  it("étend les bornes start/end sur plusieurs lignes de la même facture", () => {
    const rows = [
      { invoice_id: "a", period_start: "2026-02-01", period_end: "2026-02-15", consommation_kwh: 100 },
      { invoice_id: "a", period_start: "2026-01-01", period_end: "2026-01-31", consommation_kwh: 200 },
    ];
    const rates = computeInvoiceRates(rows);
    expect(rates[0].start).toBe("2026-01-01");
    expect(rates[0].end).toBe("2026-02-15");
    expect(rates[0].kwhPerDay).toBeCloseTo(300 / 45, 5); // 45 jours entre le 1er janv et le 15 fev
  });

  it("ignore les factures sans dates de période", () => {
    const rows = [{ invoice_id: "a", period_start: null, period_end: null, consommation_kwh: 100 }];
    expect(computeInvoiceRates(rows)).toHaveLength(0);
  });

  it("ignore les factures à kWh nul ou durée nulle", () => {
    const rows = [
      { invoice_id: "a", period_start: "2026-01-01", period_end: "2026-01-01", consommation_kwh: 100 }, // 0 jour
      { invoice_id: "b", period_start: "2026-01-01", period_end: "2026-01-31", consommation_kwh: 0 },
    ];
    expect(computeInvoiceRates(rows)).toHaveLength(0);
  });
});

describe("weightedAverageRate", () => {
  it("retourne null si aucune facture", () => {
    expect(weightedAverageRate([])).toBeNull();
  });

  it("pondère par la durée de chaque facture (pas une moyenne simple des taux)", () => {
    // Facture A : 10 kWh/j sur 10 jours = 100 kWh
    // Facture B : 20 kWh/j sur 90 jours = 1800 kWh
    // Moyenne pondérée = (100+1800)/(10+90) = 19 kWh/j, PAS (10+20)/2=15
    const rates = [
      { invoiceId: "a", kwhPerDay: 10, days: 10, start: "2026-01-01", end: "2026-01-11" },
      { invoiceId: "b", kwhPerDay: 20, days: 90, start: "2026-02-01", end: "2026-05-01" },
    ];
    expect(weightedAverageRate(rates)).toBeCloseTo(19, 5);
  });
});

describe("historicalSpan", () => {
  it("retourne null si aucune facture", () => {
    expect(historicalSpan([])).toBeNull();
  });

  it("retourne les bornes min/max sur toutes les factures", () => {
    const rates = [
      { invoiceId: "a", kwhPerDay: 1, days: 1, start: "2026-03-01", end: "2026-03-10" },
      { invoiceId: "b", kwhPerDay: 1, days: 1, start: "2026-01-01", end: "2026-01-10" },
      { invoiceId: "c", kwhPerDay: 1, days: 1, start: "2026-02-01", end: "2026-05-01" },
    ];
    expect(historicalSpan(rates)).toEqual({ start: "2026-01-01", end: "2026-05-01" });
  });
});
