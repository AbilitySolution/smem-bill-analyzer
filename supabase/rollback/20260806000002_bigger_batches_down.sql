-- Rollback de 20260806000002_bigger_batches.sql
--
-- ⚠️ Redéployer `process-document-queue` et `collect-document-batches` dans leurs
-- versions précédentes AVANT d'exécuter ce fichier : le collecteur appelle
-- `list_batches_to_collect`, que ce rollback supprime.
--
-- Effet : retour à des lots de 5 documents (soit 10× plus de lots pour le même volume,
-- donc une collecte ~10× plus lente) et à une collecte FIFO sans équité entre clients.
--
-- Les lots déjà créés avec 50 documents restent parfaitement collectables : rien dans
-- le collecteur ne dépend de la taille du lot.

DROP FUNCTION IF EXISTS public.list_batches_to_collect(integer);

-- Plafond de réservation ramené à 10.
CREATE OR REPLACE FUNCTION public.claim_fair_document_jobs(
  job_limit integer DEFAULT 5,
  stale_after_seconds integer DEFAULT 300
)
RETURNS SETOF public.document_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_org   uuid;
  stale_before timestamptz := now() - make_interval(secs => GREATEST(stale_after_seconds, 60));
BEGIN
  SELECT waiting.org_id INTO target_org
  FROM (
    SELECT DISTINCT org_id
    FROM public.document_jobs
    WHERE processing_mode = 'batch'
      AND (status = 'queued'
           OR (status = 'uploading_to_claude' AND updated_at < stale_before))
  ) AS waiting
  LEFT JOIN public.document_dispatch_cursor AS served ON served.org_id = waiting.org_id
  ORDER BY COALESCE(served.last_dispatch_at, '-infinity'::timestamptz), waiting.org_id
  LIMIT 1;

  IF target_org IS NULL THEN RETURN; END IF;

  INSERT INTO public.document_dispatch_cursor AS cursor_row (org_id, last_dispatch_at, dispatch_count)
  VALUES (target_org, now(), 1)
  ON CONFLICT (org_id) DO UPDATE
    SET last_dispatch_at = now(),
        dispatch_count = cursor_row.dispatch_count + 1;

  RETURN QUERY
  WITH candidates AS (
    SELECT id FROM public.document_jobs
    WHERE processing_mode = 'batch'
      AND org_id = target_org
      AND (status = 'queued'
           OR (status = 'uploading_to_claude' AND updated_at < stale_before))
    ORDER BY queued_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(job_limit, 1), 10)
  )
  UPDATE public.document_jobs AS jobs
  SET status = 'uploading_to_claude',
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

REVOKE ALL ON FUNCTION public.claim_fair_document_jobs(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_fair_document_jobs(integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_org_document_jobs(
  requested_org_id uuid,
  job_limit integer DEFAULT 5
)
RETURNS SETOF public.document_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  stale_before timestamptz := now() - interval '300 seconds';
BEGIN
  IF requested_org_id IS NULL THEN
    RAISE EXCEPTION 'requested_org_id is required';
  END IF;

  INSERT INTO public.document_dispatch_cursor AS cursor_row (org_id, last_dispatch_at, dispatch_count)
  VALUES (requested_org_id, now(), 1)
  ON CONFLICT (org_id) DO UPDATE
    SET last_dispatch_at = now(),
        dispatch_count = cursor_row.dispatch_count + 1;

  RETURN QUERY
  WITH candidates AS (
    SELECT id FROM public.document_jobs
    WHERE processing_mode = 'batch'
      AND org_id = requested_org_id
      AND (status = 'queued'
           OR (status = 'uploading_to_claude' AND updated_at < stale_before))
    ORDER BY queued_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(job_limit, 1), 10)
  )
  UPDATE public.document_jobs AS jobs
  SET status = 'uploading_to_claude',
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

REVOKE ALL ON FUNCTION public.claim_org_document_jobs(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_org_document_jobs(uuid, integer) TO service_role;
