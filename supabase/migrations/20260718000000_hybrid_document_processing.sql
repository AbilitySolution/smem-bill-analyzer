-- Hybrid document processing and performance instrumentation.
-- Small imports use the synchronous Claude Messages API through a durable
-- direct worker; larger imports continue to use PGMQ + Claude Message Batches.

ALTER TABLE public.document_jobs
  ADD COLUMN IF NOT EXISTS processing_mode text NOT NULL DEFAULT 'batch',
  ADD COLUMN IF NOT EXISTS queued_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS dispatch_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS claude_file_uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS batch_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS result_available_at timestamptz;

ALTER TABLE public.document_jobs
  ADD COLUMN IF NOT EXISTS benchmark_run_id uuid;

ALTER TABLE public.document_jobs DROP CONSTRAINT IF EXISTS document_jobs_processing_mode_check;
ALTER TABLE public.document_jobs
  ADD CONSTRAINT document_jobs_processing_mode_check
  CHECK (processing_mode IN ('direct', 'batch'));

ALTER TABLE public.document_jobs DROP CONSTRAINT IF EXISTS document_jobs_status_check;
ALTER TABLE public.document_jobs
  ADD CONSTRAINT document_jobs_status_check
  CHECK (status IN (
    'direct_queued', 'direct_processing',
    'queued', 'uploading_to_claude', 'batched', 'processing',
    'needs_review', 'completed', 'failed'
  ));

ALTER TABLE public.document_batches
  ADD COLUMN IF NOT EXISTS dispatch_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS anthropic_ended_at timestamptz,
  ADD COLUMN IF NOT EXISTS collection_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS result_available_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_document_jobs_direct_pending
  ON public.document_jobs(status, queued_at)
  WHERE processing_mode = 'direct' AND status = 'direct_queued';

CREATE INDEX IF NOT EXISTS idx_document_jobs_benchmark_run
  ON public.document_jobs(benchmark_run_id)
  WHERE benchmark_run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.claim_direct_document_jobs(
  requested_job_ids uuid[] DEFAULT NULL,
  requested_owner_id uuid DEFAULT NULL,
  job_limit integer DEFAULT 10
)
RETURNS SETOF public.document_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM public.document_jobs
    WHERE processing_mode = 'direct'
      AND status = 'direct_queued'
      AND (requested_job_ids IS NULL OR id = ANY(requested_job_ids))
      AND (requested_owner_id IS NULL OR created_by = requested_owner_id)
    ORDER BY queued_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(job_limit, 1), 10)
  )
  UPDATE public.document_jobs AS jobs
  SET status = 'direct_processing',
      attempt_count = jobs.attempt_count + 1,
      dispatch_started_at = COALESCE(jobs.dispatch_started_at, now()),
      started_at = COALESCE(jobs.started_at, now()),
      updated_at = now(),
      last_error = NULL
  FROM candidates
  WHERE jobs.id = candidates.id
  RETURNING jobs.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_direct_document_jobs(uuid[], uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_direct_document_jobs(uuid[], uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.retry_document_job(job_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  owner_id uuid;
  current_status text;
  job_mode text;
  message_id bigint := NULL;
BEGIN
  SELECT created_by, status, processing_mode
    INTO owner_id, current_status, job_mode
  FROM public.document_jobs
  WHERE id = job_id;

  IF owner_id IS NULL THEN RAISE EXCEPTION 'Document job not found'; END IF;
  IF auth.role() <> 'service_role' AND owner_id <> auth.uid() AND NOT public.is_admin_smem() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF current_status <> 'failed' THEN RAISE EXCEPTION 'Only failed jobs can be retried'; END IF;

  UPDATE public.document_jobs
  SET status = CASE WHEN job_mode = 'direct' THEN 'direct_queued' ELSE 'queued' END,
      last_error = NULL,
      anthropic_file_id = NULL,
      anthropic_batch_id = NULL,
      dispatch_started_at = NULL,
      claude_file_uploaded_at = NULL,
      batch_created_at = NULL,
      result_available_at = NULL,
      started_at = NULL,
      completed_at = NULL,
      updated_at = now()
  WHERE id = job_id;

  IF job_mode = 'batch' THEN
    SELECT * INTO message_id
    FROM pgmq.send('document_ocr', jsonb_build_object('job_id', job_id));
  END IF;

  RETURN message_id;
END;
$$;

DO $$
DECLARE existing_job bigint;
BEGIN
  SELECT jobid INTO existing_job
  FROM cron.job
  WHERE jobname = 'process-direct-documents';
  IF existing_job IS NOT NULL THEN PERFORM cron.unschedule(existing_job); END IF;

  PERFORM cron.schedule(
    'process-direct-documents', '* * * * *',
    $cron$
      SELECT net.http_post(
        url := project_url.secret || '/functions/v1/process-direct-documents',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || service_key.secret
        ),
        body := '{}'::jsonb
      )
      FROM
        (SELECT decrypted_secret AS secret FROM vault.decrypted_secrets WHERE name='project_url' LIMIT 1) project_url,
        (SELECT decrypted_secret AS secret FROM vault.decrypted_secrets WHERE name='service_role_key' LIMIT 1) service_key;
    $cron$
  );
END $$;
