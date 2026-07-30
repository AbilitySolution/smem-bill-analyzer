export function defaultIsRetryable(err: unknown): boolean {
  // Duck-type: SDK errors carry a .status number; network errors have no status
  const status = (err as { status?: number })?.status ?? null;
  const isNetworkError = err instanceof Error &&
    /ECONNRESET|ENOTFOUND|fetch failed|network/i.test(err.message);
  return isNetworkError || status === 429 || status === 529;
}

/**
 * Retry avec backoff exponentiel.
 * Par défaut ne retry que sur erreurs transitoires : 429 (rate limit), 529 (overload), erreurs réseau.
 * Passer un `isRetryable` personnalisé pour élargir (ex : 5xx génériques d'une autre API).
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  attempts = 3,
  delaysMs = [1000, 3000],
  isRetryable: (err: unknown) => boolean = defaultIsRetryable,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;
      const delay = delaysMs[i] ?? delaysMs[delaysMs.length - 1];
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
