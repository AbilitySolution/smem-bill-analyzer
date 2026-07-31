import { describe, it, expect } from "vitest";
import { costPerKwh, median, topSeverity } from "./anomalies";

describe("costPerKwh", () => {
  it("calcule le c€/kWh", () => {
    expect(costPerKwh(100, 1000)).toBeCloseTo(10, 5);
  });

  it("retourne null si kWh nul ou négatif", () => {
    expect(costPerKwh(100, 0)).toBeNull();
    expect(costPerKwh(100, -5)).toBeNull();
  });
});

describe("median", () => {
  it("gère pair/impair", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("retourne null pour un tableau vide", () => {
    expect(median([])).toBeNull();
  });
});

describe("topSeverity", () => {
  it("retourne la plus haute sévérité parmi une liste", () => {
    const anomalies = [
      { id: "1", type: "a", severity: "low" as const, message: "", resolved: false },
      { id: "2", type: "b", severity: "high" as const, message: "", resolved: false },
      { id: "3", type: "c", severity: "medium" as const, message: "", resolved: false },
    ];
    expect(topSeverity(anomalies)).toBe("high");
  });

  it("retourne null pour une liste vide", () => {
    expect(topSeverity([])).toBeNull();
  });
});
