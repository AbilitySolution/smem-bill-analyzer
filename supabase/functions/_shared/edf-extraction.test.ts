import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "./edf-extraction";

// Même remarque que côté Next.js : tool_choice force l'appel d'outil, donc le modèle ne peut pas
// répondre en texte libre ici. Défense en profondeur si ce forçage est un jour assoupli.
describe("edge functions extraction system prompt", () => {
  it("instructs the model to never reveal its identity or provider", () => {
    expect(SYSTEM_PROMPT).toMatch(/ne révèle jamais le nom du modèle ou du fournisseur/i);
  });

  it("does not self-identify as Claude/Anthropic anywhere in the prompt text", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/claude|anthropic/i);
  });
});
