-- Run in the staging SQL editor after benchmark runs have completed.
-- This query reads timing metadata only; it never selects invoice content.
WITH per_run AS (
  SELECT
    benchmark_run_id,
    processing_mode,
    count(*) AS document_count,
    min(queued_at) AS submitted_at,
    min(dispatch_started_at) AS first_dispatch_at,
    min(result_available_at) AS first_result_at,
    max(result_available_at) AS completed_at,
    extract(epoch FROM (min(dispatch_started_at) - min(queued_at))) AS startup_seconds,
    extract(epoch FROM (min(result_available_at) - min(queued_at))) AS first_result_seconds,
    extract(epoch FROM (max(result_available_at) - min(queued_at))) AS total_seconds,
    sum(attempt_count) - count(*) AS retries,
    count(*) FILTER (WHERE status = 'failed') AS failures
  FROM public.document_jobs
  WHERE benchmark_run_id IS NOT NULL
  GROUP BY benchmark_run_id, processing_mode
), ranked AS (
  SELECT
    *,
    total_seconds / 60.0 AS total_minutes,
    document_count / NULLIF(total_seconds / 60.0, 0) AS documents_per_minute
  FROM per_run
  WHERE completed_at IS NOT NULL
)
SELECT
  processing_mode,
  document_count,
  count(*) AS repetitions,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY startup_seconds) AS median_startup_seconds,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY startup_seconds) AS p95_startup_seconds,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY first_result_seconds) AS median_first_result_seconds,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY first_result_seconds) AS p95_first_result_seconds,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY total_seconds) AS median_total_seconds,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY total_seconds) AS p95_total_seconds,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY documents_per_minute) AS median_documents_per_minute,
  sum(retries) AS retries,
  sum(failures) AS failures
FROM ranked
GROUP BY processing_mode, document_count
ORDER BY document_count, processing_mode;

-- Batch-only infrastructure breakdown.
SELECT
  id,
  document_count,
  extract(epoch FROM (created_at - dispatch_started_at)) AS preparation_seconds,
  extract(epoch FROM (anthropic_ended_at - created_at)) AS anthropic_seconds,
  extract(epoch FROM (collection_started_at - anthropic_ended_at)) AS collector_wait_seconds,
  extract(epoch FROM (result_available_at - collection_started_at)) AS collection_seconds,
  extract(epoch FROM (result_available_at - dispatch_started_at)) AS total_worker_seconds,
  request_counts,
  last_error
FROM public.document_batches
WHERE dispatch_started_at IS NOT NULL
ORDER BY created_at DESC;
