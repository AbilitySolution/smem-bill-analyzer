-- ===== FUITE DE FICHIERS FOURNISSEUR + SANTÉ DE LA FILE =====
--
-- ── 1. `retry_document_job` : ne plus détruire le handle du fichier distant ──────
--
-- La relance mettait `anthropic_file_id = NULL` sans supprimer le fichier chez le
-- fournisseur : le pointeur disparaissait, le fichier restait. Chaque relance laissait
-- donc une copie du PDF — un document client confidentiel — sur les serveurs du
-- fournisseur, orpheline et définitivement insupprimable.
--
-- Correctif : conserver `anthropic_file_id`. Déployé conjointement avec
-- `releaseRemoteFile` dans les workers, le cycle devient :
--
--   échec terminal → le worker supprime le fichier distant PUIS efface le pointeur ;
--                    si la suppression distante échoue, le pointeur est CONSERVÉ ;
--   relance        → cette fonction ne touche plus au pointeur : s'il est NULL
--                    (cas normal), le worker ré-uploade ; s'il subsiste (suppression
--                    distante ratée), le worker réutilise le fichier — pas de fuite,
--                    pas de handle perdu, dans les deux cas.
--
-- `anthropic_batch_id` reste remis à NULL : le lot précédent, lui, est bien terminé.
-- Cas `rejected_non_invoice` : inchangé — le chemin de rejet a déjà supprimé le fichier
-- distant et mis la colonne à NULL avant d'arriver ici.

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

-- ── 2. Santé de la file : deux fonctions de lecture pour la vue Exploitation ─────
--
-- `document_jobs` porte 7 horodatages d'instrumentation ; 4 n'ont jamais été lus par
-- quoi que ce soit (`claude_file_uploaded_at`, `batch_created_at`, `started_at`,
-- `completed_at`). Ces fonctions exploitent enfin les deux premiers.
--
-- `started_at` et `completed_at` restent volontairement inutilisés : `started_at` est
-- écrit à l'identique de `dispatch_started_at` (même COALESCE, mêmes endroits) et
-- `completed_at` au même instant que `result_available_at` sur tous les chemins. Les
-- mesurer serait mesurer deux fois la même chose.
--
-- SECURITY INVOKER — déviation assumée de la convention DEFINER du dépôt : le seul
-- appelant légitime est le service-role, qui contourne la RLS nativement. En INVOKER,
-- si le GRANT est un jour élargi par erreur, la RLS clampe le résultat à l'organisation
-- de l'appelant au lieu de fuiter la file de tous les clients. Un DEFINER offrirait un
-- primitif de lecture inter-organisations sans garde possible (le cross-org est
-- précisément la fonction).

/**
 * Photographie de la file : une ligne par (organisation, statut) non terminal, plus
 * les documents en attente d'enregistrement automatique. Volume borné par
 * organisations × statuts — une poignée de lignes.
 */
CREATE OR REPLACE FUNCTION public.queue_health_live()
RETURNS TABLE(
  org_id uuid,
  org_name text,
  status text,
  processing_mode text,
  job_count bigint,
  oldest_at timestamptz,
  max_attempt_count integer,
  awaiting_auto_save bigint
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT
    jobs.org_id,
    org.nom AS org_name,
    jobs.status,
    jobs.processing_mode,
    count(*) AS job_count,
    min(COALESCE(jobs.dispatch_started_at, jobs.queued_at)) AS oldest_at,
    max(jobs.attempt_count) AS max_attempt_count,
    count(*) FILTER (
      WHERE jobs.status = 'needs_review' AND jobs.auto_save_attempted_at IS NULL
    ) AS awaiting_auto_save
  FROM public.document_jobs AS jobs
  JOIN public.organizations AS org ON org.id = jobs.org_id
  WHERE jobs.status NOT IN ('completed', 'failed', 'rejected_non_invoice')
  GROUP BY jobs.org_id, org.nom, jobs.status, jobs.processing_mode
  ORDER BY org.nom, jobs.status;
$$;

REVOKE ALL ON FUNCTION public.queue_health_live() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_health_live() TO service_role;

/**
 * Durées par étape du pipeline (p50 / p90 / max) sur une fenêtre glissante.
 *
 * Dépivot par `CROSS JOIN LATERAL (VALUES …)` : un seul balayage de la table. Garde
 * `seconds >= 0` : une relance remet les horodatages à NULL, et une horloge peut
 * reculer d'un tick entre deux écritures.
 *
 * L'étape `enregistrement_auto` est le test de régression permanent du Cron
 * d'auto-save : si elle cesse d'avoir des échantillons récents, le Cron est retombé.
 */
CREATE OR REPLACE FUNCTION public.queue_health_stages(window_hours integer DEFAULT 168)
RETURNS TABLE(
  processing_mode text,
  stage text,
  sample_count bigint,
  p50_seconds numeric,
  p90_seconds numeric,
  max_seconds numeric
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH samples AS (
    SELECT
      jobs.processing_mode,
      stage.name AS stage,
      stage.seconds
    FROM public.document_jobs AS jobs
    CROSS JOIN LATERAL (VALUES
      ('attente_dispatch',
        EXTRACT(EPOCH FROM jobs.dispatch_started_at - jobs.queued_at)),
      ('televersement',
        EXTRACT(EPOCH FROM jobs.claude_file_uploaded_at - jobs.dispatch_started_at)),
      ('lot_fournisseur',
        EXTRACT(EPOCH FROM jobs.result_available_at - jobs.batch_created_at)),
      ('extraction_directe',
        CASE WHEN jobs.processing_mode = 'direct'
          THEN EXTRACT(EPOCH FROM jobs.result_available_at - jobs.claude_file_uploaded_at)
        END),
      ('bout_en_bout',
        EXTRACT(EPOCH FROM jobs.result_available_at - jobs.queued_at)),
      ('enregistrement_auto',
        EXTRACT(EPOCH FROM jobs.auto_save_attempted_at - jobs.result_available_at))
    ) AS stage(name, seconds)
    WHERE jobs.queued_at >= now() - make_interval(hours => LEAST(GREATEST(window_hours, 1), 8760))
      AND stage.seconds IS NOT NULL
      AND stage.seconds >= 0
  )
  SELECT
    samples.processing_mode,
    samples.stage,
    count(*) AS sample_count,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY samples.seconds)::numeric, 1) AS p50_seconds,
    round(percentile_cont(0.9) WITHIN GROUP (ORDER BY samples.seconds)::numeric, 1) AS p90_seconds,
    round(max(samples.seconds)::numeric, 1) AS max_seconds
  FROM samples
  GROUP BY samples.processing_mode, samples.stage
  ORDER BY samples.processing_mode, samples.stage;
$$;

REVOKE ALL ON FUNCTION public.queue_health_stages(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_health_stages(integer) TO service_role;

-- Pas de nouvel index : à ~2 000 documents/mois, la table met des années à devenir
-- coûteuse à balayer, et `idx_document_jobs_status_created_at` couvre la requête live.
