import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "./extract-prompt";

// L'API d'extraction force tool_choice sur extract_edf_invoice : le modèle ne peut pas produire
// de texte libre en réponse à une question directe ("quel modèle es-tu ?"). Cette instruction est
// une défense en profondeur au cas où ce forçage serait un jour assoupli.
describe("extraction system prompt", () => {
  it("instructs the model to never reveal its identity or provider", () => {
    expect(SYSTEM_PROMPT).toMatch(/ne révèle jamais le nom du modèle ou du fournisseur/i);
  });

  it("does not self-identify as Claude/Anthropic anywhere in the prompt text", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/claude|anthropic/i);
  });
});
