-- ROLLBACK 5/6 — annule 20260715010000_claude_batches.sql
-- Retire l'orchestration Claude Message Batches. Retour à une file OCR simple.
-- Destructif : perte de tout l'historique des lots (document_batches).

-- ⚠️ PRÉALABLE — aucun lot ne doit être en vol :
--   select anthropic_batch_id, status, document_count, created_at
--   from public.document_batches where status = 'in_progress';
-- Les annuler (POST /v1/messages/batches/{id}/cancel) ou attendre leur expiration :
-- un lot supprimé ici continue de tourner et de facturer chez le fournisseur.
--
-- ⚠️ Les jobs en statut 'uploading_to_claude' ou 'batched' doivent être remis en file :
--   update public.document_jobs set status = 'queued', anthropic_file_id = NULL,
--          anthropic_batch_id = NULL, updated_at = now()
--   where status in ('uploading_to_claude','batched');

-- 1. Couper les Cron AVANT tout DROP.
DO $$
DECLARE existing_job bigint;
BEGIN
  FOR existing_job IN
    SELECT jobid FROM cron.job
    WHERE jobname IN ('dispatch-claude-batches','collect-claude-batches')
  LOOP
    PERFORM cron.unschedule(existing_job);
  END LOOP;
END $$;

BEGIN;

-- 2. Restaure la liste de statuts d'origine (5 valeurs, état 20260715000000).
ALTER TABLE public.document_jobs DROP CONSTRAINT IF EXISTS document_jobs_status_check;
ALTER TABLE public.document_jobs
  ADD CONSTRAINT document_jobs_status_check
  CHECK (status IN ('queued','processing','needs_review','completed','failed'));

-- 3. Supprime le claim multiple (le claim unitaire de 20260715000000 subsiste).
DROP FUNCTION IF EXISTS public.claim_document_jobs(integer, integer);

-- 4. Supprime la table des lots et les colonnes associées.
DROP INDEX IF EXISTS public.idx_document_jobs_anthropic_batch;
DROP TABLE IF EXISTS public.document_batches;

ALTER TABLE public.document_jobs
  DROP COLUMN IF EXISTS anthropic_file_id,
  DROP COLUMN IF EXISTS anthropic_batch_id;

-- 5. Restaure retry_document_job dans sa version 20260715000000/20260715020000.
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

-- 6. Remet en place le Cron worker unique de 20260715000000.
DO $$
DECLARE existing_job bigint;
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

COMMIT;

-- 7. Retirer l'Edge Function (hors SQL) :
--   npx supabase functions delete collect-document-batches --project-ref <REF>
