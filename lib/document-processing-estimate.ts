import type { DocumentJob } from "@/lib/types/document-job";

export const DOCUMENTS_PER_BATCH = 5;
export const DISPATCH_INTERVAL_SECONDS = 60;

const FALLBACK_P50_SECONDS = 385;
const FALLBACK_P80_SECONDS = 600;
const COLLECTOR_BUFFER_SECONDS = 60;

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

function safeStats(stats?: ProcessingEstimateStats | null) {
  if (!stats || stats.sampleCount < 5) return fallbackEstimateStats();
  return stats;
}

function toRange(minimumSeconds: number, maximumSeconds: number): EstimateRange {
  const minimumMinutes = Math.max(1, Math.ceil(minimumSeconds / 60));
  const maximumMinutes = Math.max(minimumMinutes + 1, Math.ceil(maximumSeconds / 60));
  return { minimumMinutes, maximumMinutes };
}

export function estimateForDocumentCount(documentCount: number, stats?: ProcessingEstimateStats | null) {
  if (documentCount <= 0) return null;
  const calibrated = safeStats(stats);
  const batchCount = Math.ceil(documentCount / DOCUMENTS_PER_BATCH);
  const dispatchSpread = Math.max(0, batchCount - 1) * DISPATCH_INTERVAL_SECONDS;
  const conservativeP80 = Math.max(calibrated.p80BatchSeconds, calibrated.p50BatchSeconds * 1.35);

  return toRange(
    dispatchSpread + calibrated.p50BatchSeconds + COLLECTOR_BUFFER_SECONDS / 2,
    dispatchSpread + conservativeP80 + COLLECTOR_BUFFER_SECONDS * 1.5,
  );
}

export function estimateRemainingForJobs(jobs: DocumentJob[], stats?: ProcessingEstimateStats | null, now = Date.now()) {
  const active = jobs.filter((job) => !["needs_review", "completed", "failed"].includes(job.status));
  if (!active.length) return null;

  const calibrated = safeStats(stats);
  const queuedCount = active.filter((job) => job.status === "queued" || job.status === "uploading_to_claude").length;
  let minimumSeconds = 0;
  let maximumSeconds = 0;

  if (queuedCount) {
    const queuedEstimate = estimateForDocumentCount(queuedCount, calibrated);
    minimumSeconds = (queuedEstimate?.minimumMinutes ?? 1) * 60;
    maximumSeconds = (queuedEstimate?.maximumMinutes ?? 2) * 60;
  }

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

