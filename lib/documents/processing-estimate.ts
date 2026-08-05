import { isTerminalJobStatus, type DocumentJob } from "@/lib/types/document-job";

/**
 * Estimation de durée affichée pendant l'import.
 *
 * Deux régimes très différents :
 *   - `direct` : appel synchrone, ~20 s par document, 3 en parallèle ;
 *   - `batch`  : soumission par sous-lots de 5, un dispatch par minute, puis attente
 *                du fournisseur — de quelques minutes à plusieurs heures.
 *
 * Les constantes de repli servent tant qu'on n'a pas 5 lots terminés à mesurer ;
 * au-delà, `/api/document-jobs` renvoie les percentiles réels observés.
 */

export const DOCUMENTS_PER_BATCH = 5;
export const DISPATCH_INTERVAL_SECONDS = 60;

const FALLBACK_P50_SECONDS = 385;
const FALLBACK_P80_SECONDS = 600;
const COLLECTOR_BUFFER_SECONDS = 60;

/** Mesuré sur le worker direct : ~20 s par document, 3 en parallèle. */
const DIRECT_SECONDS_PER_DOCUMENT = 20;
const DIRECT_CONCURRENCY = 3;

export interface ProcessingEstimateStats {
  sampleCount: number;
  p50BatchSeconds: number;
  p80BatchSeconds: number;
  source: "historical" | "fallback";
  generatedAt: string;
}

export interface EstimateRange {
  minimumMinutes: number;
  maximumMinutes: number;
}

export function fallbackEstimateStats(): ProcessingEstimateStats {
  return {
    sampleCount: 0,
    p50BatchSeconds: FALLBACK_P50_SECONDS,
    p80BatchSeconds: FALLBACK_P80_SECONDS,
    source: "fallback",
    generatedAt: new Date().toISOString(),
  };
}

/** Sous 5 mesures, l'échantillon ne vaut rien : on garde le repli prudent. */
function safeStats(stats?: ProcessingEstimateStats | null) {
  if (!stats || stats.sampleCount < 5) return fallbackEstimateStats();
  return stats;
}

function toRange(minimumSeconds: number, maximumSeconds: number): EstimateRange {
  const minimumMinutes = Math.max(1, Math.ceil(minimumSeconds / 60));
  const maximumMinutes = Math.max(minimumMinutes + 1, Math.ceil(maximumSeconds / 60));
  return { minimumMinutes, maximumMinutes };
}

function directSeconds(documentCount: number): { minimum: number; maximum: number } {
  const waves = Math.ceil(documentCount / DIRECT_CONCURRENCY);
  return {
    minimum: waves * DIRECT_SECONDS_PER_DOCUMENT,
    maximum: waves * DIRECT_SECONDS_PER_DOCUMENT * 2.5,
  };
}

function batchSeconds(documentCount: number, stats: ProcessingEstimateStats) {
  const batchCount = Math.ceil(documentCount / DOCUMENTS_PER_BATCH);
  const dispatchSpread = Math.max(0, batchCount - 1) * DISPATCH_INTERVAL_SECONDS;
  const conservativeP80 = Math.max(stats.p80BatchSeconds, stats.p50BatchSeconds * 1.35);
  return {
    minimum: dispatchSpread + stats.p50BatchSeconds + COLLECTOR_BUFFER_SECONDS / 2,
    maximum: dispatchSpread + conservativeP80 + COLLECTOR_BUFFER_SECONDS * 1.5,
  };
}

/** Estimation avant envoi, à partir du nombre de fichiers sélectionnés. */
export function estimateForDocumentCount(
  documentCount: number,
  stats?: ProcessingEstimateStats | null,
  mode: "direct" | "batch" = "batch",
): EstimateRange | null {
  if (documentCount <= 0) return null;
  const seconds = mode === "direct"
    ? directSeconds(documentCount)
    : batchSeconds(documentCount, safeStats(stats));
  return toRange(seconds.minimum, seconds.maximum);
}

/** Temps restant pour des jobs déjà en cours, en retranchant le temps écoulé. */
export function estimateRemainingForJobs(
  jobs: DocumentJob[],
  stats?: ProcessingEstimateStats | null,
  now = Date.now(),
): EstimateRange | null {
  const active = jobs.filter((job) => !isTerminalJobStatus(job.status));
  if (!active.length) return null;

  const calibrated = safeStats(stats);
  let minimumSeconds = 0;
  let maximumSeconds = 0;

  const directCount = active.filter((job) => job.processing_mode === "direct").length;
  if (directCount) {
    const direct = directSeconds(directCount);
    minimumSeconds = Math.max(minimumSeconds, direct.minimum);
    maximumSeconds = Math.max(maximumSeconds, direct.maximum);
  }

  // Jobs `batch` pas encore soumis : ils attendent encore leur dispatch.
  const queuedCount = active.filter(
    (job) => job.status === "queued" || job.status === "uploading_to_claude",
  ).length;
  if (queuedCount) {
    const queued = batchSeconds(queuedCount, calibrated);
    minimumSeconds = Math.max(minimumSeconds, queued.minimum);
    maximumSeconds = Math.max(maximumSeconds, queued.maximum);
  }

  // Lots déjà chez le fournisseur : on part de leur âge réel, un lot par identifiant.
  const activeBatches = new Map<string, DocumentJob>();
  for (const job of active) {
    if (!job.anthropic_batch_id) continue;
    const current = activeBatches.get(job.anthropic_batch_id);
    if (!current || new Date(job.updated_at).getTime() < new Date(current.updated_at).getTime()) {
      activeBatches.set(job.anthropic_batch_id, job);
    }
  }

  for (const job of activeBatches.values()) {
    const elapsedSeconds = Math.max(0, (now - new Date(job.updated_at).getTime()) / 1000);
    minimumSeconds = Math.max(minimumSeconds, calibrated.p50BatchSeconds - elapsedSeconds + COLLECTOR_BUFFER_SECONDS / 2);
    maximumSeconds = Math.max(maximumSeconds, calibrated.p80BatchSeconds - elapsedSeconds + COLLECTOR_BUFFER_SECONDS * 1.5);
  }

  return toRange(Math.max(30, minimumSeconds), Math.max(90, maximumSeconds));
}
