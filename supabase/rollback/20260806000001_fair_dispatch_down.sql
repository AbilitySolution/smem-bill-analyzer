-- Rollback de 20260806000001_fair_dispatch.sql
--
-- ⚠️ ORDRE IMPÉRATIF : redéployer `process-document-queue` dans sa version pgmq AVANT
-- d'exécuter ce fichier. La version équitable appelle `claim_fair_document_jobs` ; ce
-- rollback la supprime, le worker répondrait 500 à chaque tick entre les deux.
--
-- ⚠️ Ce rollback RÉTABLIT le couplage inter-clients : file FIFO globale (une
-- organisation qui dépose 200 documents bloque les autres) et lots Anthropic
-- multi-organisations.
--
-- Les jobs restés en `queued` au moment du rollback n'ont plus de message pgmq — la
-- file a été détruite par la migration. Il faut les ré-enfiler explicitement, sinon ils
-- ne repartent jamais (dernière étape ci-dessous).

-- 1. Recréer la file et les trois fonctions pgmq, à l'identique de 20260805000000.
DO $$
BEGIN
  PERFORM pgmq.create('document_ocr');
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN unique_violation THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.enqueue_document_job(job_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  owner_id uuid;
  job_org  uuid;
  message_id bigint;
BEGIN
  SELECT created_by, org_id INTO owner_id, job_org
  FROM public.document_jobs WHERE id = job_id;

  IF owner_id IS NULL THEN RAISE EXCEPTION 'Document job not found'; END IF;

  IF auth.role() <> 'service_role'
     AND (job_org <> public.current_user_org_id()
          OR (owner_id <> auth.uid() AND NOT public.is_org_admin())) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO message_id
  FROM pgmq.send('document_ocr', jsonb_build_object('job_id', job_id));

  RETURN message_id;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_document_job(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_document_job(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.claim_document_jobs(
  visibility_timeout_seconds integer DEFAULT 300,
  message_limit integer DEFAULT 5
)
RETURNS TABLE(message_id bigint, job_id uuid, read_count integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
  SELECT message.msg_id, (message.message->>'job_id')::uuid, message.read_ct
  FROM pgmq.read(
    'document_ocr',
    GREATEST(visibility_timeout_seconds, 60),
    LEAST(GREATEST(message_limit, 1), 10)
  ) AS message;
$$;

REVOKE ALL ON FUNCTION public.claim_document_jobs(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_document_jobs(integer, integer) TO service_role;

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

-- 2. Rétablir `retry_document_job` avec son `pgmq.send`.
CREATE OR REPLACE FUNCTION public.retry_document_job(job_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  owner_id       uuid;
  job_org        uuid;
  current_status text;
  job_mode       text;
  message_id     bigint := NULL;
  was_rejected   boolean;
BEGIN
  SELECT created_by, org_id, status, processing_mode
    INTO owner_id, job_org, current_status, job_mode
  FROM public.document_jobs WHERE id = job_id;

  IF owner_id IS NULL THEN RAISE EXCEPTION 'Document job not found'; END IF;

  IF auth.role() <> 'service_role'
     AND (job_org <> public.current_user_org_id()
          OR (owner_id <> auth.uid() AND NOT public.is_org_admin())) THEN
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

REVOKE ALL ON FUNCTION public.retry_document_job(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retry_document_job(uuid) TO authenticated, service_role;

-- 3. Rétablir `claim_direct_document_jobs` sans reprise des jobs figés.
--    (Un job bloqué en `direct_processing` redevient irrécupérable.)
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
    SELECT id FROM public.document_jobs
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

-- 4. Retirer l'ordonnancement équitable.
DROP FUNCTION IF EXISTS public.claim_fair_document_jobs(integer, integer);
DROP FUNCTION IF EXISTS public.claim_org_document_jobs(uuid, integer);
DROP TABLE IF EXISTS public.document_dispatch_cursor;
DROP INDEX IF EXISTS public.idx_document_jobs_batch_dispatchable;
DROP INDEX IF EXISTS public.idx_document_jobs_direct_reapable;

DROP POLICY IF EXISTS "org_read_document_batches" ON public.document_batches;
DROP INDEX IF EXISTS public.idx_document_batches_org_created;
-- `document_batches.org_id` est conservé : additif, sans dépendance, et il documente
-- quels lots étaient mono-organisation. Le retirer ne rapporte rien.

-- 5. OBLIGATOIRE — ré-enfiler les jobs en attente, sans quoi ils ne repartent jamais.
INSERT INTO pgmq.q_document_ocr (vt, message)
SELECT now(), jsonb_build_object('job_id', id)
FROM public.document_jobs
WHERE processing_mode = 'batch'
  AND status IN ('queued', 'uploading_to_claude');
