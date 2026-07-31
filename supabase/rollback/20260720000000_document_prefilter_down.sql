-- ROLLBACK 2/6 — annule 20260720000000_document_prefilter.sql
-- Retire le pré-filtrage Haiku et restaure retry_document_job dans sa version 20260718.

-- ⚠️ PRÉALABLE — requalifier les jobs rejetés, sinon ils violeront le CHECK restauré :
--   update public.document_jobs
--   set status = 'failed', last_error = 'Rejeté par le pré-filtre (rollback)'
--   where status = 'rejected_non_invoice';
-- Vérification (doit renvoyer 0) :
--   select count(*) from public.document_jobs where status = 'rejected_non_invoice';

BEGIN;

-- 1. Restaure la liste de statuts à 9 valeurs (état 20260718).
ALTER TABLE public.document_jobs DROP CONSTRAINT IF EXISTS document_jobs_status_check;
ALTER TABLE public.document_jobs
  ADD CONSTRAINT document_jobs_status_check
  CHECK (status IN (
    'direct_queued', 'direct_processing',
    'queued', 'uploading_to_claude', 'batched', 'processing',
    'needs_review', 'completed', 'failed'
  ));

-- 2. Retire les colonnes du pré-filtre.
ALTER TABLE public.document_jobs DROP CONSTRAINT IF EXISTS document_jobs_prefilter_type_check;
ALTER TABLE public.document_jobs
  DROP COLUMN IF EXISTS prefilter_type,
  DROP COLUMN IF EXISTS skip_prefilter;

-- 3. Restaure retry_document_job sans la logique skip_prefilter (version 20260718).
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

COMMIT;

-- NOTE : public.is_admin_smem() doit exister. Sur une base post-multi-tenant,
-- remplacer les appels par public.is_org_admin() avant exécution.
