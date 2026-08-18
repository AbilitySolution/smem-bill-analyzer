import { describe, it, expect } from "vitest";
import {
  chainedIndex, coverageByMonth, findFixedPanel,
  MIN_PANEL_MONTHS, type MonthSiteKwh,
} from "./series-bias";

/** Construit la carte (mois -> site -> kWh) à partir d'une écriture compacte. */
function build(spec: Record<string, Record<string, number>>): MonthSiteKwh {
  const map: MonthSiteKwh = new Map();
  for (const [month, sites] of Object.entries(spec)) {
    map.set(month, new Map(Object.entries(sites)));
  }
  return map;
}

/** N mois consécutifs à partir de janvier `year`, mêmes sites, mêmes valeurs. */
function steady(year: number, months: number, sites: Record<string, number>) {
  const spec: Record<string, Record<string, number>> = {};
  for (let i = 0; i < months; i++) {
    const y = year + Math.floor(i / 12);
    const m = String((i % 12) + 1).padStart(2, "0");
    spec[`${y}-${m}`] = { ...sites };
  }
  return spec;
}

describe("coverageByMonth", () => {
  it("compte les sites couverts, zéro pour un mois absent", () => {
    const data = build({ "2024-01": { a: 10, b: 20 }, "2024-03": { a: 10 } });
    expect(coverageByMonth(data, ["2024-01", "2024-02", "2024-03"]))
      .toEqual([
        { key: "2024-01", sites: 2 },
        { key: "2024-02", sites: 0 },
        { key: "2024-03", sites: 1 },
      ]);
  });
});

describe("chainedIndex", () => {
  it("consommation stable -> indice plat à 100", () => {
    const data = build(steady(2024, 6, { a: 100, b: 100, c: 100 }));
    const out = chainedIndex(data, Object.keys(steady(2024, 6, { a: 1 })));
    expect(out.every((p) => p.index === 100)).toBe(true);
  });

  it("LE cas qui justifie le chaînage : l'arrivée d'un site ne crée pas de fausse hausse", () => {
    // Trois sites stables à 100. Au 3e mois, un quatrième site entre avec 900 kWh.
    // Le total mensuel passe de 300 à 1200 : la courbe brute affiche +300 %, alors
    // qu'aucun site n'a changé de consommation. L'indice chaîné doit rester à 100.
    const data = build({
      "2024-01": { a: 100, b: 100, c: 100 },
      "2024-02": { a: 100, b: 100, c: 100 },
      "2024-03": { a: 100, b: 100, c: 100, nouveau: 900 },
      "2024-04": { a: 100, b: 100, c: 100, nouveau: 900 },
    });
    const keys = ["2024-01", "2024-02", "2024-03", "2024-04"];
    const out = chainedIndex(data, keys);

    const brut = keys.map((k) => [...data.get(k)!.values()].reduce((s, v) => s + v, 0));
    expect(brut).toEqual([300, 300, 1200, 1200]); // la courbe brute quadruple…
    expect(out.map((p) => p.index)).toEqual([100, 100, 100, 100]); // …l'indice, non
  });

  it("une vraie hausse est bien captée", () => {
    const data = build({
      "2024-01": { a: 100, b: 100, c: 100 },
      "2024-02": { a: 150, b: 150, c: 150 },
    });
    const out = chainedIndex(data, ["2024-01", "2024-02"]);
    expect(out[1].index).toBeCloseTo(150, 6);
  });

  it("moins de 3 sites communs -> série interrompue plutôt que trait mensonger", () => {
    const data = build({
      "2024-01": { a: 100, b: 100, c: 100 },
      "2024-02": { z: 5 }, // aucun site commun
      "2024-03": { z: 5, y: 5, x: 5 },
    });
    const out = chainedIndex(data, ["2024-01", "2024-02", "2024-03"]);
    expect(out[1].index).toBeNull();
    expect(out[1].common).toBe(0);
  });
});

describe("findFixedPanel", () => {
  it("couverture parfaite et longue -> panel accepté sur toute la période", () => {
    const spec = steady(2020, 24, { a: 10, b: 10, c: 10 });
    const keys = Object.keys(spec);
    const panel = findFixedPanel(build(spec), keys, 3);
    expect(panel.ok).toBe(true);
    expect(panel.siteIds.sort()).toEqual(["a", "b", "c"]);
    expect(panel.months).toHaveLength(24);
    expect(panel.excluded).toEqual([]);
    expect(panel.siteSpans.every((s) => s.months === 24)).toBe(true);
  });

  it("fenêtre trop courte -> refus, même à couverture totale", () => {
    const spec = steady(2024, MIN_PANEL_MONTHS - 1, { a: 10, b: 10 });
    const panel = findFixedPanel(build(spec), Object.keys(spec), 2);
    expect(panel.ok).toBe(false);
    expect(panel.months.length).toBeLessThan(MIN_PANEL_MONTHS);
  });

  it("sites arrivés tard -> refus, et les empans de couverture restent exploitables — cas « Gros Morne »", () => {
    // 5 sites : un seul couvre les 24 mois, les 4 autres n'apparaissent qu'au 19e.
    // La meilleure fenêtre à 5 sites ne dure que 6 mois : trop court, donc refus.
    const spec: Record<string, Record<string, number>> = {};
    const keys: string[] = [];
    for (let i = 0; i < 24; i++) {
      const key = `${2022 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
      keys.push(key);
      spec[key] = i < 18 ? { a: 10 } : { a: 10, b: 10, c: 10, d: 10, e: 10 };
    }
    const panel = findFixedPanel(build(spec), keys, 5);
    expect(panel.ok).toBe(false);
    expect(panel.months.length).toBeLessThan(MIN_PANEL_MONTHS);

    // `excluded` est VIDE ici — la meilleure fenêtre contient bien les 5 sites, elle est
    // juste trop courte. C'est précisément pourquoi le message de refus doit s'appuyer
    // sur les empans et non sur `excluded`.
    expect(panel.excluded).toEqual([]);
    expect(panel.siteSpans).toHaveLength(5);
    expect(panel.siteSpans[0].months).toBe(6);            // trié : le moins couvert d'abord
    expect(panel.siteSpans[0].firstMonth).toBe(keys[18]);
    expect(panel.siteSpans.at(-1)?.months).toBe(24);      // le site historique
    expect(panel.siteSpans.at(-1)?.siteId).toBe("a");
  });

  it("retient la plus longue fenêtre où un panel suffisant tient — cas « Carbet »", () => {
    // 8 sites présents 13 mois, 2 de plus n'arrivent qu'au 8e mois : le panel figé est
    // celui des 8 sites (80 % des 10), sur les 13 mois complets.
    const spec: Record<string, Record<string, number>> = {};
    const keys: string[] = [];
    const eight = { s1: 1, s2: 1, s3: 1, s4: 1, s5: 1, s6: 1, s7: 1, s8: 1 };
    for (let i = 0; i < 13; i++) {
      const key = `2023-${String(i + 1).padStart(2, "0")}`;
      keys.push(key);
      spec[key] = i < 7 ? { ...eight } : { ...eight, s9: 1, s10: 1 };
    }
    const panel = findFixedPanel(build(spec), keys, 10);
    expect(panel.ok).toBe(true);
    expect(panel.siteIds).toHaveLength(8);
    expect(panel.months).toHaveLength(13);
    expect(panel.excluded.map((e) => e.siteId).sort()).toEqual(["s10", "s9"]);
  });

  it("site unique couvert longtemps -> accepté (le seuil de 60 % vaut 1 site sur 1)", () => {
    const spec = steady(2020, 30, { seul: 42 });
    const panel = findFixedPanel(build(spec), Object.keys(spec), 1);
    expect(panel.ok).toBe(true);
    expect(panel.siteIds).toEqual(["seul"]);
  });

  it("aucune donnée -> refus propre plutôt qu'exception", () => {
    const panel = findFixedPanel(new Map(), [], 0);
    expect(panel.ok).toBe(false);
    expect(panel.from).toBeNull();
    expect(panel.months).toEqual([]);
  });
});
