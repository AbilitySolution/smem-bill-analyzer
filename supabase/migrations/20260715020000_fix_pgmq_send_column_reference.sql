-- pgmq 1.5.1's send() returns SETOF bigint (unnamed column), not a row with msg_id.
-- Both functions below referenced a nonexistent "msg_id" column, causing 42703 on every enqueue/retry.
-- Fix applied to staging (hfihvslrzmlukpjjxdmy) on 2026-07-17; also baked into the two
-- migrations above so a fresh environment never hits the bug.

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
