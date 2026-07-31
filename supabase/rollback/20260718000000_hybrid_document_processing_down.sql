-- ROLLBACK 3/6 — annule 20260718000000_hybrid_document_processing.sql
-- Retire le mode « direct », l'instrumentation de latence et le Cron associé.
-- Destructif : perte de toutes les métriques de performance et des benchmarks.

-- ⚠️ PRÉALABLE — basculer les jobs « direct » vers le mode batch, sinon ils
-- violeront le CHECK restauré et resteront bloqués sans worker :
--   update public.document_jobs
--   set status = 'queued', processing_mode = 'batch'
--   where status in ('direct_queued','direct_processing');
--   -- puis les réinjecter dans pgmq :
--   select pgmq.send('document_ocr', jsonb_build_object('job_id', id))
--   from public.document_jobs where status = 'queued';
-- Vérification (doit renvoyer 0) :
--   select count(*) from public.document_jobs where processing_mode = 'direct';

-- 1. Couper le Cron AVANT tout DROP.
DO $$
DECLARE existing_job bigint;
BEGIN
  SELECT jobid INTO existing_job FROM cron.job WHERE jobname = 'process-direct-documents';
  IF existing_job IS NOT NULL THEN PERFORM cron.unschedule(existing_job); END IF;
END $$;

BEGIN;

-- 2. Restaure la liste de statuts à 7 valeurs (état 20260715010000).
ALTER TABLE public.document_jobs DROP CONSTRAINT IF EXISTS document_jobs_status_check;
ALTER TABLE public.document_jobs
  ADD CONSTRAINT document_jobs_status_check
  CHECK (status IN ('queued','uploading_to_claude','batched','processing','needs_review','completed','failed'));

-- 3. Supprime le worker direct.
DROP FUNCTION IF EXISTS public.claim_direct_document_jobs(uuid[], uuid, integer);

-- 4. Supprime les index partiels.
DROP INDEX IF EXISTS public.idx_document_jobs_direct_pending;
DROP INDEX IF EXISTS public.idx_document_jobs_benchmark_run;

-- 5. Retire les colonnes de mode et d'instrumentation.
ALTER TABLE public.document_jobs DROP CONSTRAINT IF EXISTS document_jobs_processing_mode_check;
ALTER TABLE public.document_jobs
  DROP COLUMN IF EXISTS processing_mode,
  DROP COLUMN IF EXISTS queued_at,
  DROP COLUMN IF EXISTS dispatch_started_at,
  DROP COLUMN IF EXISTS claude_file_uploaded_at,
  DROP COLUMN IF EXISTS batch_created_at,
  DROP COLUMN IF EXISTS result_available_at,
  DROP COLUMN IF EXISTS benchmark_run_id;

ALTER TABLE public.document_batches
  DROP COLUMN IF EXISTS dispatch_started_at,
  DROP COLUMN IF EXISTS anthropic_ended_at,
  DROP COLUMN IF EXISTS collection_started_at,
  DROP COLUMN IF EXISTS result_available_at;

-- 6. Restaure retry_document_job dans sa version 20260715010000 (sans processing_mode).
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

COMMIT;

-- 7. Retirer l'Edge Function (hors SQL) :
--   npx supabase functions delete process-direct-documents --project-ref <REF>
