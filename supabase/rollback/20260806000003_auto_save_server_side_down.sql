-- Rollback de 20260806000003_auto_save_server_side.sql
--
-- ⚠️ Retirer d'abord la tâche planifiée (`crons` dans vercel.json, ou le job pg_cron
-- équivalent) : sans `list_orgs_pending_auto_save`, chaque tick répondrait 500.
--
-- ⚠️ Effet fonctionnel : l'enregistrement automatique redevient dépendant d'un onglet
-- ouvert sur `/upload`. Un dépôt en mode `batch` dont les résultats reviennent après la
-- fermeture de l'onglet reste en `needs_review` jusqu'à la prochaine visite.

DROP FUNCTION IF EXISTS public.list_orgs_pending_auto_save(integer);
DROP INDEX IF EXISTS public.idx_document_jobs_auto_save_pending;

-- `retry_document_job` sans la remise à zéro du marqueur.
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
      attempt_count = 0,
      updated_at = now()
  WHERE id = job_id;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.retry_document_job(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retry_document_job(uuid) TO authenticated, service_role;

-- `auto_save_attempted_at` est conservée : additive, sans dépendance, et elle documente
-- quels documents ont déjà été examinés. La retirer ne rapporte rien et ferait perdre
-- cette trace si la migration est rejouée.
