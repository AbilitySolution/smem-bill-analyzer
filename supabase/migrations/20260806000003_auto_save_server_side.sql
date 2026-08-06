-- ===== ENREGISTREMENT AUTOMATIQUE CÔTÉ SERVEUR =====
--
-- L'enregistrement automatique tournait uniquement dans le navigateur, déclenché par la
-- page d'import. En mode `batch`, les résultats reviennent après des minutes ou des
-- heures : l'onglet est fermé, personne n'appelle la route, et les documents restent en
-- `needs_review` indéfiniment. Un dépôt de 200 factures parti le soir n'était toujours
-- pas enregistré le lendemain.
--
-- Un Cron appelle désormais la même route. Il lui faut une chose que la mémoire du
-- navigateur fournissait jusqu'ici (`autoProcessedRef`) : savoir quels documents ont
-- déjà été examinés.
--
-- Sans ce marqueur, un document sous le seuil de confiance — qui reste `needs_review`
-- par construction, en attente de relecture humaine — serait réexaminé à CHAQUE tick,
-- pour toujours, en refaisant le rapprochement de commune à chaque fois.
--
-- Bénéfice secondaire côté navigateur : `autoProcessedRef` est perdu à chaque
-- rechargement de page, donc ces mêmes documents étaient déjà réexaminés inutilement à
-- chaque visite de `/upload`. Le marqueur corrige les deux.

ALTER TABLE public.document_jobs
  ADD COLUMN IF NOT EXISTS auto_save_attempted_at timestamptz;

COMMENT ON COLUMN public.document_jobs.auto_save_attempted_at IS
  'Date du passage de l''enregistrement automatique. NULL = jamais examiné. Renseigné même quand le document part en révision manuelle : c''est une trace d''examen, pas de succès.';

-- Cible exacte du balayage du Cron, et rien d'autre.
CREATE INDEX IF NOT EXISTS idx_document_jobs_auto_save_pending
  ON public.document_jobs(org_id, result_available_at)
  WHERE status = 'needs_review' AND auto_save_attempted_at IS NULL;

/**
 * Organisations ayant des documents à examiner, la plus anciennement en attente
 * d'abord. Même principe de tourniquet que le dispatch et la collecte : un client avec
 * 200 documents en attente ne doit pas monopoliser les invocations du Cron.
 *
 * Renvoie aussi le volume en attente, pour que l'appelant puisse répartir son budget.
 */
CREATE OR REPLACE FUNCTION public.list_orgs_pending_auto_save(org_limit integer DEFAULT 5)
RETURNS TABLE(org_id uuid, pending_count bigint, oldest_pending timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    jobs.org_id,
    count(*) AS pending_count,
    min(COALESCE(jobs.result_available_at, jobs.updated_at)) AS oldest_pending
  FROM public.document_jobs AS jobs
  WHERE jobs.status = 'needs_review'
    AND jobs.auto_save_attempted_at IS NULL
  GROUP BY jobs.org_id
  ORDER BY oldest_pending
  LIMIT LEAST(GREATEST(org_limit, 1), 50);
$$;

REVOKE ALL ON FUNCTION public.list_orgs_pending_auto_save(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_orgs_pending_auto_save(integer) TO service_role;

-- Une relance repart d'une extraction neuve : le verdict d'enregistrement automatique
-- précédent ne vaut plus rien, il doit être réexaminé.
CREATE OR REPLACE FUNCTION public.retry_document_job(job_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  owner_id       uuid;
  job_org        uuid;
  current_status text;
  job_mode       text;
  was_rejected   boolean;
BEGIN
  SELECT created_by, org_id, status, processing_mode
    INTO owner_id, job_org, current_status, job_mode
  FROM public.document_jobs
  WHERE id = job_id;

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
      auto_save_attempted_at = NULL,
      attempt_count = 0,
      updated_at = now()
  WHERE id = job_id;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.retry_document_job(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retry_document_job(uuid) TO authenticated, service_role;
