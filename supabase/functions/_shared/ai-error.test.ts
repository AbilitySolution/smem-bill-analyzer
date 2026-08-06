import { describe, expect, it } from "vitest";
import { GENERIC_UNAVAILABLE_MESSAGE, toUserSafeError } from "./ai-error.ts";

describe("toUserSafeError", () => {
  it("retire l'URL de documentation au lieu de la mutiler", () => {
    // Message réellement reçu, tel qu'il s'affichait dans la file de traitement :
    // « https://docs.le service d'extraction.com/en/docs/build-with-le service
    //   d'extraction/files#error-handling »
    const raw = '400: {"type":"error","error":{"type":"invalid_request_error",'
      + '"message":"filename: includes a forbidden character. Please consult our '
      + 'documentation at https://docs.anthropic.com/en/docs/build-with-claude/files#error-handling"}}';
    const { userMessage, logMessage } = toUserSafeError(new Error(raw));

    expect(userMessage).toContain("filename: includes a forbidden character");
    expect(userMessage).not.toContain("http");
    expect(userMessage).not.toContain("docs.");
    expect(userMessage).not.toMatch(/anthropic|claude/i);
    // Le message brut reste intact pour les logs serveur.
    expect(logMessage).toBe(raw);
  });

  it("masque toujours le nom du fournisseur hors URL", () => {
    expect(toUserSafeError(new Error("Claude Files upload failed")).userMessage)
      .not.toMatch(/anthropic|claude/i);
  });

  it("conserve le code statut, qui sert au diagnostic", () => {
    expect(toUserSafeError(new Error("529: overloaded")).userMessage).toContain("529");
  });

  it("remplace entièrement une erreur de facturation", () => {
    expect(toUserSafeError(new Error("Your credit balance is too low")).userMessage)
      .toBe(GENERIC_UNAVAILABLE_MESSAGE);
  });

  it("ne laisse pas de ponctuation orpheline", () => {
    expect(toUserSafeError(new Error("See https://docs.anthropic.com/x .")).userMessage)
      .toBe("See.");
  });
});
