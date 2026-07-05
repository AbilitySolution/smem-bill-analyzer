import Anthropic from "@anthropic-ai/sdk";

export function createAnthropicClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
}

export const OCR_MODEL = "claude-sonnet-4-6";

/**
 * Retry avec backoff exponentiel pour les appels Claude.
 * Ne retry que sur erreurs transitoires : 429 (rate limit), 529 (overload), erreurs réseau.
 * Erreurs 4xx autres (prompt invalide, schema incorrect) → fail immédiatement.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  attempts = 3,
  delaysMs = [1000, 3000],
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Duck-type: SDK errors carry a .status number; network errors have no status
      const status = (err as { status?: number })?.status ?? null;
      const isNetworkError = err instanceof Error &&
        /ECONNRESET|ENOTFOUND|fetch failed|network/i.test(err.message);
      const isRetryable = isNetworkError || status === 429 || status === 529;
      if (!isRetryable || i === attempts - 1) throw err;
      const delay = delaysMs[i] ?? delaysMs[delaysMs.length - 1];
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
