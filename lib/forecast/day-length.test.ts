import { describe, it, expect } from "vitest";
import { nightLengthHours, averageNightLengthHours } from "./day-length";

describe("nightLengthHours", () => {
  it("à l'équateur, nuit ~12h toute l'année", () => {
    const dates = [
      new Date(Date.UTC(2026, 0, 15)),
      new Date(Date.UTC(2026, 5, 21)), // solstice été (hémisphère nord)
      new Date(Date.UTC(2026, 11, 21)), // solstice hiver
    ];
    for (const d of dates) {
      expect(nightLengthHours(0, d)).toBeCloseTo(12, 0);
    }
  });

  it("Martinique (~14.6°N) : nuit toujours entre 10.5h et 13.5h (tropiques, faible variation saisonnière)", () => {
    const dates = [
      new Date(Date.UTC(2026, 0, 1)),
      new Date(Date.UTC(2026, 3, 1)),
      new Date(Date.UTC(2026, 5, 21)),
      new Date(Date.UTC(2026, 8, 1)),
      new Date(Date.UTC(2026, 11, 21)),
    ];
    for (const d of dates) {
      const n = nightLengthHours(14.6, d);
      expect(n).toBeGreaterThan(10.5);
      expect(n).toBeLessThan(13.5);
    }
  });

  it("hémisphère nord été : nuit plus courte à haute latitude qu'à l'équateur", () => {
    const summerSolstice = new Date(Date.UTC(2026, 5, 21));
    const parisNight = nightLengthHours(48.85, summerSolstice);
    const equatorNight = nightLengthHours(0, summerSolstice);
    expect(parisNight).toBeLessThan(equatorNight);
  });

  it("hémisphère nord hiver : nuit plus longue à haute latitude qu'à l'équateur", () => {
    const winterSolstice = new Date(Date.UTC(2026, 11, 21));
    const parisNight = nightLengthHours(48.85, winterSolstice);
    const equatorNight = nightLengthHours(0, winterSolstice);
    expect(parisNight).toBeGreaterThan(equatorNight);
  });

  it("symétrie hémisphère nord/sud : même |latitude|, dates à 6 mois d'écart -> nuits égales", () => {
    const juneDate = new Date(Date.UTC(2026, 5, 21));
    const decDate = new Date(Date.UTC(2026, 11, 21));
    expect(nightLengthHours(40, juneDate)).toBeCloseTo(nightLengthHours(-40, decDate), 1);
  });

  it("ne retourne jamais NaN, même aux latitudes polaires", () => {
    expect(Number.isNaN(nightLengthHours(89, new Date(Date.UTC(2026, 5, 21))))).toBe(false);
    expect(Number.isNaN(nightLengthHours(-89, new Date(Date.UTC(2026, 11, 21))))).toBe(false);
  });
});

describe("averageNightLengthHours", () => {
  it("moyenne sur un jour unique = nightLengthHours de ce jour", () => {
    const d = new Date(Date.UTC(2026, 2, 15));
    expect(averageNightLengthHours(14.6, d, d)).toBeCloseTo(nightLengthHours(14.6, d), 5);
  });

  it("moyenne sur une période reste dans les bornes min/max de la période", () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    const end = new Date(Date.UTC(2026, 5, 30));
    const avg = averageNightLengthHours(14.6, start, end);
    expect(avg).toBeGreaterThan(10);
    expect(avg).toBeLessThan(14);
  });
});
