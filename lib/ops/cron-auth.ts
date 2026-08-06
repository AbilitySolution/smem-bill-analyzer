import { timingSafeEqual } from "node:crypto";

/**
 * Authentification des tâches planifiées (Vercel Cron, pg_cron + pg_net).
 *
 * Extrait de `app/api/document-jobs/auto-save/route.ts` pour être partagé avec
 * `/api/cron/maintenance`. Comparaison à temps constant : le secret ne doit pas fuiter
 * par la latence. Variable absente → toujours `false` — les routes échouent fermées.
 */
export function matchesCronSecret(header: string): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(header);
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
