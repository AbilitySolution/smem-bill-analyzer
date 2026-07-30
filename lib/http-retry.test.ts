import { describe, it, expect, vi } from "vitest";
import { retryWithBackoff, defaultIsRetryable } from "./http-retry";

describe("defaultIsRetryable", () => {
  it("retry sur status 429 et 529", () => {
    expect(defaultIsRetryable({ status: 429 })).toBe(true);
    expect(defaultIsRetryable({ status: 529 })).toBe(true);
  });

  it("ne retry pas sur les autres status", () => {
    expect(defaultIsRetryable({ status: 400 })).toBe(false);
    expect(defaultIsRetryable({ status: 500 })).toBe(false);
  });

  it("retry sur erreurs réseau connues", () => {
    expect(defaultIsRetryable(new Error("fetch failed"))).toBe(true);
    expect(defaultIsRetryable(new Error("ECONNRESET"))).toBe(true);
  });

  it("ne retry pas sur une erreur générique sans status", () => {
    expect(defaultIsRetryable(new Error("bad request body"))).toBe(false);
  });
});

describe("retryWithBackoff", () => {
  it("retourne le résultat immédiatement si succès du premier coup", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, 3, [0, 0]);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retry sur erreur transitoire puis réussit", async () => {
    const err = Object.assign(new Error("rate limited"), { status: 429 });
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce("ok");
    const result = await retryWithBackoff(fn, 3, [0, 0]);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("échoue immédiatement sur erreur non-retryable (pas de retry)", async () => {
    const err = Object.assign(new Error("bad request"), { status: 400 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retryWithBackoff(fn, 3, [0, 0])).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("abandonne après le nombre max de tentatives", async () => {
    const err = Object.assign(new Error("rate limited"), { status: 429 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retryWithBackoff(fn, 3, [0, 0])).rejects.toThrow("rate limited");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respecte un prédicat isRetryable personnalisé", async () => {
    const err = Object.assign(new Error("server error"), { status: 503 });
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce("ok");
    const isRetryable = (e: unknown) => (e as { status?: number })?.status === 503;
    const result = await retryWithBackoff(fn, 3, [0, 0], isRetryable);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
