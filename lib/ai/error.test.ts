import { describe, expect, it } from "vitest";
import { GENERIC_UNAVAILABLE_MESSAGE, toUserSafeError } from "./error";

const VENDOR_TERMS = /claude|anthropic/i;

describe("toUserSafeError", () => {
  it("returns the generic message for a credit balance error and keeps the raw text server-side only", () => {
    const raw = "Your credit balance is too low to access the Claude API. Please go to Plans & Billing to upgrade.";
    const { userMessage, logMessage } = toUserSafeError(new Error(raw));

    expect(userMessage).toBe(GENERIC_UNAVAILABLE_MESSAGE);
    expect(userMessage).not.toMatch(VENDOR_TERMS);
    expect(logMessage).toBe(raw);
  });

  it("detects billing errors regardless of casing", () => {
    const { userMessage } = toUserSafeError(new Error("BILLING error: account suspended"));
    expect(userMessage).toBe(GENERIC_UNAVAILABLE_MESSAGE);
  });

  it("detects insufficient credit errors", () => {
    const { userMessage } = toUserSafeError(new Error("insufficient credit for this request"));
    expect(userMessage).toBe(GENERIC_UNAVAILABLE_MESSAGE);
  });

  it("strips the vendor name from non-credit errors but preserves useful detail", () => {
    const raw = "Claude Files 400: {\"type\":\"invalid_request_error\",\"message\":\"file too large\"}";
    const { userMessage, logMessage } = toUserSafeError(new Error(raw));

    expect(userMessage).not.toMatch(VENDOR_TERMS);
    expect(userMessage).toContain("400");
    expect(userMessage).toContain("file too large");
    expect(logMessage).toBe(raw);
  });

  it("strips a bare vendor mention from network/other errors", () => {
    const { userMessage } = toUserSafeError(new Error("Anthropic request failed"));
    expect(userMessage).not.toMatch(VENDOR_TERMS);
  });

  it("leaves unrelated errors (network, validation, timeout) functionally unchanged", () => {
    const raw = "ECONNRESET: socket hang up";
    const { userMessage } = toUserSafeError(new Error(raw));
    expect(userMessage).toBe(raw);
  });

  it("never leaks the vendor name in the user-facing message across a range of real-world error shapes", () => {
    const samples = [
      "Claude Batch 429: rate limited",
      "Claude Classify 500: internal error",
      "429: {\"error\":{\"type\":\"rate_limit_error\"}}",
      "Your credit balance is too low to access the Claude API.",
      "billing issue detected on this Anthropic account",
    ];
    for (const raw of samples) {
      const { userMessage } = toUserSafeError(new Error(raw));
      expect(userMessage).not.toMatch(VENDOR_TERMS);
    }
  });
});
