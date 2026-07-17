-- Durable OCR document queue.
-- Business state lives in public.document_jobs; pgmq only transports job ids.

CREATE EXTENSION IF NOT EXISTS pgmq;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  PERFORM pgmq.create('document_ocr');
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN unique_violation THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.document_jobs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_path             text NOT NULL,
  original_name         text NOT NULL,
  mime_type              text NOT NULL,
  file_size              bigint NOT NULL CHECK (file_size > 0 AND file_size <= 20971520),
  status                 text NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','processing','needs_review','completed','failed')),
  attempt_count          integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  extraction_json        jsonb,
  validation_json        jsonb,
  suggested_commune_id   uuid REFERENCES public.communes(id) ON DELETE SET NULL,
  suggested_site_id      uuid REFERENCES public.sites(id) ON DELETE SET NULL,
  processed_invoice_id   uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  last_error             text,
  started_at             timestamptz,
  completed_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_jobs_created_by_created_at
  ON public.document_jobs(created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_jobs_status_created_at
  ON public.document_jobs(status, created_at);

ALTER TABLE public.document_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owners_read_document_jobs" ON public.document_jobs
  FOR SELECT USING (created_by = auth.uid() OR public.is_admin_smem());

-- Job creation and status changes are performed by server-side code only.
-- Users can read their own jobs, while service_role bypasses RLS for the worker.

CREATE OR REPLACE FUNCTION public.enqueue_document_job(job_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  owner_id uuid;
  message_id bigint;
BEGIN
  SELECT created_by INTO owner_id
  FROM public.document_jobs
  WHERE id = job_id;

  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'Document job not found';
  END IF;

  IF auth.role() <> 'service_role'
     AND owner_id <> auth.uid()
     AND NOT public.is_admin_smem() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO message_id
  FROM pgmq.send('document_ocr', jsonb_build_object('job_id', job_id));

  RETURN message_id;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_document_job(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_document_job(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.retry_document_job(job_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  owner_id uuid;
  current_status text;
  message_id bigint;
BEGIN
  SELECT created_by, status INTO owner_id, current_status
  FROM public.document_jobs
  WHERE id = job_id;

  IF owner_id IS NULL THEN RAISE EXCEPTION 'Document job not found'; END IF;
  IF auth.role() <> 'service_role'
     AND owner_id <> auth.uid()
     AND NOT public.is_admin_smem() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF current_status <> 'failed' THEN
    RAISE EXCEPTION 'Only failed jobs can be retried';
  END IF;

  UPDATE public.document_jobs
  SET status = 'queued', last_error = NULL, updated_at = now()
  WHERE id = job_id;

  SELECT * INTO message_id
  FROM pgmq.send('document_ocr', jsonb_build_object('job_id', job_id));
  RETURN message_id;
END;
$$;

REVOKE ALL ON FUNCTION public.retry_document_job(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retry_document_job(uuid) TO authenticated, service_role;

-- Worker-only wrappers keep the pgmq schema private from the Data API.
CREATE OR REPLACE FUNCTION public.claim_document_job(
  visibility_timeout_seconds integer DEFAULT 180
)
RETURNS TABLE(message_id bigint, job_id uuid, read_count integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
  SELECT
    message.msg_id,
    (message.message->>'job_id')::uuid,
    message.read_ct
  FROM pgmq.read(
    'document_ocr',
    GREATEST(visibility_timeout_seconds, 30),
    1
  ) AS message;
$$;

REVOKE ALL ON FUNCTION public.claim_document_job(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_document_job(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.acknowledge_document_job(message_id bigint)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
  SELECT pgmq.archive('document_ocr', message_id);
$$;

REVOKE ALL ON FUNCTION public.acknowledge_document_job(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acknowledge_document_job(bigint) TO service_role;

ALTER PUBLICATION supabase_realtime ADD TABLE public.document_jobs;

-- Safety-net consumer. It becomes active as soon as the two Vault secrets
-- `project_url` and `service_role_key` are created (see README).
DO $$
DECLARE
  existing_job bigint;
BEGIN
  SELECT jobid INTO existing_job FROM cron.job WHERE jobname = 'process-document-ocr-queue';
  IF existing_job IS NOT NULL THEN PERFORM cron.unschedule(existing_job); END IF;

  PERFORM cron.schedule(
    'process-document-ocr-queue',
    '* * * * *',
    $cron$
      SELECT net.http_post(
        url := project_url.secret || '/functions/v1/process-document-queue',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || service_key.secret
        ),
        body := '{}'::jsonb
      )
      FROM
        (SELECT decrypted_secret AS secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1) project_url,
        (SELECT decrypted_secret AS secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1) service_key;
    $cron$
  );
END $$;
