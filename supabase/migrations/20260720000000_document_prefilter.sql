-- Pré-filtrage bon marché (Claude Haiku, page unique) avant l'extraction Sonnet complète.
-- Rejette les documents qui ne sont pas des factures d'électricité individuelles
-- (bordereaux récapitulatifs, courriers, etc.) sans payer le coût d'extraction complet.

ALTER TABLE public.document_jobs
  ADD COLUMN IF NOT EXISTS prefilter_type text,
  ADD COLUMN IF NOT EXISTS skip_prefilter boolean NOT NULL DEFAULT false;

ALTER TABLE public.document_jobs DROP CONSTRAINT IF EXISTS document_jobs_prefilter_type_check;
ALTER TABLE public.document_jobs
  ADD CONSTRAINT document_jobs_prefilter_type_check
  CHECK (prefilter_type IS NULL OR prefilter_type IN ('facture', 'bordereau_recapitulatif', 'autre'));

ALTER TABLE public.document_jobs DROP CONSTRAINT IF EXISTS document_jobs_status_check;
ALTER TABLE public.document_jobs
  ADD CONSTRAINT document_jobs_status_check
  CHECK (status IN (
    'direct_queued', 'direct_processing',
    'queued', 'uploading_to_claude', 'batched', 'processing',
    'needs_review', 'completed', 'failed', 'rejected_non_invoice'
  ));

-- Un job rejeté à tort peut être relancé une seule fois en forçant l'extraction
-- (skip_prefilter = true), sans repasser par le classifieur.
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
  was_rejected boolean;
BEGIN
  SELECT created_by, status, processing_mode
    INTO owner_id, current_status, job_mode
  FROM public.document_jobs
  WHERE id = job_id;

  IF owner_id IS NULL THEN RAISE EXCEPTION 'Document job not found'; END IF;
  IF auth.role() <> 'service_role' AND owner_id <> auth.uid() AND NOT public.is_admin_smem() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF current_status NOT IN ('failed', 'rejected_non_invoice') THEN
    RAISE EXCEPTION 'Only failed or rejected jobs can be retried';
  END IF;
  was_rejected := current_status = 'rejected_non_invoice';

  UPDATE public.document_jobs
  SET status = CASE WHEN job_mode = 'direct' THEN 'direct_queued' ELSE 'queued' END,
      last_error = NULL,
      skip_prefilter = skip_prefilter OR was_rejected,
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
