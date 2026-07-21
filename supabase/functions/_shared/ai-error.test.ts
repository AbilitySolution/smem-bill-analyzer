import { describe, expect, it } from "vitest";
import { GENERIC_UNAVAILABLE_MESSAGE, isCreditError, toUserSafeError } from "./ai-error";

const VENDOR_TERMS = /claude|anthropic/i;

describe("edge functions: toUserSafeError", () => {
  it("returns the generic message for a credit balance error", () => {
    const raw = "429: {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"Your credit balance is too low\"}}";
    const { userMessage, logMessage } = toUserSafeError(new Error(raw));

    expect(userMessage).toBe(GENERIC_UNAVAILABLE_MESSAGE);
    expect(userMessage).not.toMatch(VENDOR_TERMS);
    expect(logMessage).toBe(raw);
  });

  it("identifies credit/billing errors independently of the generic sanitizer", () => {
    expect(isCreditError("insufficient credit balance")).toBe(true);
    expect(isCreditError("billing dispute")).toBe(true);
    expect(isCreditError("408: request timeout")).toBe(false);
  });

  it("keeps other Anthropic REST errors informative while removing the vendor name", () => {
    const raw = "Claude Batch 400: {\"type\":\"invalid_request_error\",\"message\":\"custom_id too long\"}";
    const { userMessage } = toUserSafeError(new Error(raw));
    expect(userMessage).not.toMatch(VENDOR_TERMS);
    expect(userMessage).toContain("custom_id too long");
  });

  it("leaves genuinely unrelated errors (network, validation, timeout) unchanged", () => {
    const raw = "fichier absent de Supabase Storage";
    const { userMessage } = toUserSafeError(new Error(raw));
    expect(userMessage).toBe(raw);
  });
});
