import { describe, it, expect } from "vitest";
import { classifyTarif } from "./consumption";

describe("classifyTarif", () => {
  it.each([
    ["Heures Pleines", "HP"],
    ["heures pleines", "HP"],
    ["HP", "HP"],
    ["HPB", "HP"],
    ["HPBN", "HP"],
    ["TEMPO_HP", "HP"],
    ["Heures Creuses", "HC"],
    ["HC", "HC"],
    ["HCB", "HC"],
    ["EJP_HC", "HC"],
    ["BASE", "Base"],
    ["autre chose", "Base"],
    ["", "Base"],
  ])("classe %s -> %s", (input, expected) => {
    expect(classifyTarif(input)).toBe(expected);
  });
});
