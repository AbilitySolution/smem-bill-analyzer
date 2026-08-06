import { createAdminClient } from "@/lib/supabase/admin";
import { getPlatformOperator } from "@/lib/auth-platform";

/**
 * Santé de la file de traitement documentaire, toutes organisations confondues.
 * Alimente la page /exploitation (opérateur Ability) et le digest de maintenance.
 *
 * Trois déviations assumées de la convention `lib/data/` :
 *
 *   1. `createAdminClient()` et non le client de session : la lecture inter-
 *      organisations est la fonction, la RLS la bloquerait par construction.
 *   2. Le contrôle d'accès est DANS `getQueueHealth()` — `getPlatformOperator()`
 *      renvoie null → la fonction renvoie null. Point d'étranglement unique : un futur
 *      appelant ne peut pas oublier le gate, il est incontournable. (`getQueueHealthAs
 *      Service` est la variante pour les appels déjà authentifiés par CRON_SECRET.)
 *   3. Pas de constante `DEMO_*` : des chiffres inventés sur une page d'exploitation
 *      seraient dangereux — pendant un incident, on lirait des données fictives.
 *      L'état vide est la vérité.
 */

export interface QueueHealthLiveRow {
  org_id: string;
  org_name: string;
  status: string;
  processing_mode: "direct" | "batch";
  job_count: number;
  oldest_at: string | null;
  max_attempt_count: number;
  awaiting_auto_save: number;
}

export interface QueueHealthStageRow {
  processing_mode: "direct" | "batch";
  stage: string;
  sample_count: number;
  p50_seconds: number;
  p90_seconds: number;
  max_seconds: number;
}

export interface RecentFailure {
  id: string;
  org_name: string;
  original_name: string;
  attempt_count: number;
  last_error: string | null;
  updated_at: string;
}

export interface QueueHealth {
  live: QueueHealthLiveRow[];
  stages: QueueHealthStageRow[];
  recentFailures: RecentFailure[];
  failures24h: number;
  generatedAt: string;
}

/**
 * Seuils « bloqué » par statut, en millisecondes.
 *
 * Calés sur la mécanique de reprise : `uploading_to_claude` est repris à 300 s et
 * `direct_processing` à 900 s ; au triple sans progression, quelque chose ne tourne
 * plus (Cron pg_cron mort, secrets Vault absents — pannes documentées comme
 * silencieuses). `queued`/`batched` dépendent du fournisseur : seuils plus larges.
 */
const STUCK_THRESHOLDS_MS: Record<string, number> = {
  queued: 15 * 60 * 1000,
  direct_queued: 15 * 60 * 1000,
  uploading_to_claude: 15 * 60 * 1000,
  direct_processing: 45 * 60 * 1000,
  batched: 3 * 60 * 60 * 1000,
  processing: 3 * 60 * 60 * 1000,
  needs_review: Number.POSITIVE_INFINITY,
};

/** Une ligne de la photographie est-elle bloquée au-delà du seuil de son statut ? */
export function isStuck(row: Pick<QueueHealthLiveRow, "status" | "oldest_at">, now = Date.now()): boolean {
  if (!row.oldest_at) return false;
  const threshold = STUCK_THRESHOLDS_MS[row.status] ?? 60 * 60 * 1000;
  return now - new Date(row.oldest_at).getTime() > threshold;
}

/** Documents en attente d'enregistrement automatique depuis plus de 10 minutes. */
export function awaitingAutoSaveCount(live: QueueHealthLiveRow[], now = Date.now()): number {
  return live
    .filter((row) => row.status === "needs_review" && row.awaiting_auto_save > 0)
    .filter((row) => !row.oldest_at || now - new Date(row.oldest_at).getTime() > 10 * 60 * 1000)
    .reduce((total, row) => total + row.awaiting_auto_save, 0);
}

/** Total de documents bloqués (hors `needs_review`, qui attend l'humain par design). */
export function stuckCount(live: QueueHealthLiveRow[], now = Date.now()): number {
  return live
    .filter((row) => row.status !== "needs_review" && isStuck(row, now))
    .reduce((total, row) => total + row.job_count, 0);
}

async function fetchQueueHealth(): Promise<QueueHealth | null> {
  const admin = createAdminClient();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [liveRes, stagesRes, failuresRes, failures24hRes] = await Promise.all([
    admin.rpc("queue_health_live"),
    admin.rpc("queue_health_stages", { window_hours: 168 }),
    admin.from("document_jobs")
      .select("id, original_name, attempt_count, last_error, updated_at, organizations(nom)")
      .eq("status", "failed")
      .gte("updated_at", weekAgo)
      .order("updated_at", { ascending: false })
      .limit(50),
    admin.from("document_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "failed")
      .gte("updated_at", dayAgo),
  ]);

  if (liveRes.error || stagesRes.error || failuresRes.error) return null;

  const recentFailures: RecentFailure[] = (failuresRes.data ?? []).map((row) => {
    const record = row as unknown as {
      id: string; original_name: string; attempt_count: number;
      last_error: string | null; updated_at: string;
      organizations: { nom: string } | { nom: string }[] | null;
    };
    const org = Array.isArray(record.organizations) ? record.organizations[0] : record.organizations;
    return {
      id: record.id,
      org_name: org?.nom ?? "—",
      original_name: record.original_name,
      attempt_count: record.attempt_count,
      last_error: record.last_error,
      updated_at: record.updated_at,
    };
  });

  return {
    live: (liveRes.data ?? []) as QueueHealthLiveRow[],
    stages: (stagesRes.data ?? []) as QueueHealthStageRow[],
    recentFailures,
    failures24h: failures24hRes.count ?? 0,
    generatedAt: new Date().toISOString(),
  };
}

/** Lecture pour la page /exploitation : gate opérateur incorporé, incontournable. */
export async function getQueueHealth(): Promise<QueueHealth | null> {
  const operator = await getPlatformOperator();
  if (!operator) return null;
  return fetchQueueHealth();
}

/**
 * Lecture pour la maintenance planifiée : l'appelant a déjà prouvé `CRON_SECRET`
 * (`matchesCronSecret`), il n'a pas de session utilisateur à vérifier.
 */
export async function getQueueHealthAsService(): Promise<QueueHealth | null> {
  return fetchQueueHealth();
}
