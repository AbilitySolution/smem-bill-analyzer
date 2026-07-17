-- Claude Message Batches orchestration for high-volume imports.

ALTER TABLE public.document_jobs DROP CONSTRAINT IF EXISTS document_jobs_status_check;
ALTER TABLE public.document_jobs
  ADD CONSTRAINT document_jobs_status_check
  CHECK (status IN ('queued','uploading_to_claude','batched','processing','needs_review','completed','failed'));

ALTER TABLE public.document_jobs
  ADD COLUMN IF NOT EXISTS anthropic_file_id text,
  ADD COLUMN IF NOT EXISTS anthropic_batch_id text;

CREATE TABLE IF NOT EXISTS public.document_batches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anthropic_batch_id    text NOT NULL UNIQUE,
  status                text NOT NULL DEFAULT 'in_progress'
                        CHECK (status IN ('in_progress','ended','failed')),
  document_count        integer NOT NULL CHECK (document_count > 0),
  request_counts        jsonb,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.document_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_read_document_batches" ON public.document_batches
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE INDEX IF NOT EXISTS idx_document_batches_status
  ON public.document_batches(status, created_at);
CREATE INDEX IF NOT EXISTS idx_document_jobs_anthropic_batch
  ON public.document_jobs(anthropic_batch_id);

CREATE OR REPLACE FUNCTION public.claim_document_jobs(
  visibility_timeout_seconds integer DEFAULT 300,
  message_limit integer DEFAULT 5
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
    GREATEST(visibility_timeout_seconds, 60),
    LEAST(GREATEST(message_limit, 1), 10)
  ) AS message;
$$;

REVOKE ALL ON FUNCTION public.claim_document_jobs(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_document_jobs(integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.retry_document_job(job_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE owner_id uuid; current_status text; message_id bigint;
BEGIN
  SELECT created_by, status INTO owner_id, current_status FROM public.document_jobs WHERE id = job_id;
  IF owner_id IS NULL THEN RAISE EXCEPTION 'Document job not found'; END IF;
  IF auth.role() <> 'service_role' AND owner_id <> auth.uid() AND NOT public.is_admin_smem() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF current_status <> 'failed' THEN RAISE EXCEPTION 'Only failed jobs can be retried'; END IF;

  UPDATE public.document_jobs SET
    status='queued', last_error=NULL, anthropic_file_id=NULL,
    anthropic_batch_id=NULL, updated_at=now()
  WHERE id=job_id;
  SELECT * INTO message_id FROM pgmq.send('document_ocr', jsonb_build_object('job_id', job_id));
  RETURN message_id;
END;
$$;

-- Replace the old single worker Cron with a dispatcher and a result collector.
DO $$
DECLARE existing_job bigint;
BEGIN
  FOR existing_job IN
    SELECT jobid FROM cron.job
    WHERE jobname IN ('process-document-ocr-queue','dispatch-claude-batches','collect-claude-batches')
  LOOP
    PERFORM cron.unschedule(existing_job);
  END LOOP;

  PERFORM cron.schedule(
    'dispatch-claude-batches', '* * * * *',
    $cron$
      SELECT net.http_post(
        url := project_url.secret || '/functions/v1/process-document-queue',
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || service_key.secret),
        body := '{}'::jsonb
      )
      FROM
        (SELECT decrypted_secret AS secret FROM vault.decrypted_secrets WHERE name='project_url' LIMIT 1) project_url,
        (SELECT decrypted_secret AS secret FROM vault.decrypted_secrets WHERE name='service_role_key' LIMIT 1) service_key;
    $cron$
  );

  PERFORM cron.schedule(
    'collect-claude-batches', '* * * * *',
    $cron$
      SELECT net.http_post(
        url := project_url.secret || '/functions/v1/collect-document-batches',
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || service_key.secret),
        body := '{}'::jsonb
      )
      FROM
        (SELECT decrypted_secret AS secret FROM vault.decrypted_secrets WHERE name='project_url' LIMIT 1) project_url,
        (SELECT decrypted_secret AS secret FROM vault.decrypted_secrets WHERE name='service_role_key' LIMIT 1) service_key;
    $cron$
  );
END $$;
