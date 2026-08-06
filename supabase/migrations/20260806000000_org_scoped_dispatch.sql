-- ===== DÉCOUPLAGE DES ORGANISATIONS SUR LE DISPATCH `batch` =====
--
-- `claim_document_jobs` lit la file pgmq **globale**. `process-document-queue` étant
-- invoqué par le navigateur au dépôt (jeton utilisateur, `verify_jwt = true`), n'importe
-- quel utilisateur authentifié mettait ainsi en traitement les documents de n'importe
-- quelle organisation.
--
-- Aucune donnée ne fuitait — les résultats retombent toujours sur les bonnes lignes,
-- protégées par RLS — mais les tenants n'étaient pas découplés pour autant :
--   - le budget d'extraction d'une organisation pouvait être consommé par une autre ;
--   - un lot pouvait être retardé, ou passé en `failed`, par l'erreur d'un tiers
--     (le worker rétrograde tous les jobs réservés quand la soumission échoue) ;
--   - une organisation inactive ne pouvait pas savoir pourquoi ses documents partaient.
--
-- On sépare donc les deux appelants :
--   - Cron (service_role) : continue de vider la file pgmq globale, tous tenants
--     confondus. C'est le filet de sécurité, il doit tout voir.
--   - navigateur (jeton utilisateur) : réserve directement dans `document_jobs`, borné à
--     son organisation par `claim_org_document_jobs`.
--
-- Le message pgmq d'un job réservé par la voie utilisateur reste en file : le Cron le
-- lira plus tard, verra le job déjà `batched` / `needs_review` / `rejected_non_invoice`
-- et l'acquittera. C'est la garde anti-double-traitement déjà présente dans le worker —
-- aucun document n'est traité deux fois, aucun message ne fuit.

-- Index partiel jumeau de `idx_document_jobs_direct_pending`, côté `batch` et par org :
-- c'est le seul balayage de la nouvelle fonction.
CREATE INDEX IF NOT EXISTS idx_document_jobs_batch_pending
  ON public.document_jobs(org_id, queued_at)
  WHERE processing_mode = 'batch' AND status = 'queued';

/**
 * Réservation des jobs `batch` d'UNE organisation.
 *
 * Même contrat que `claim_direct_document_jobs` : `FOR UPDATE SKIP LOCKED` + passage
 * atomique en `uploading_to_claude`, donc deux invocations concurrentes ne peuvent pas
 * réserver le même job. Le compteur de tentatives est incrémenté ici : l'appelant ne
 * doit pas le refaire.
 *
 * `requested_org_id` est obligatoire — un appel sans organisation n'a aucun sens et
 * rouvrirait précisément la porte que cette migration ferme.
 */
CREATE OR REPLACE FUNCTION public.claim_org_document_jobs(
  requested_org_id uuid,
  job_limit integer DEFAULT 5
)
RETURNS SETOF public.document_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF requested_org_id IS NULL THEN
    RAISE EXCEPTION 'requested_org_id is required';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM public.document_jobs
    WHERE processing_mode = 'batch'
      AND status = 'queued'
      AND org_id = requested_org_id
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

-- Comme les autres fonctions de réservation : jamais exposée à `authenticated`. C'est
-- l'Edge Function, elle seule, qui résout l'organisation depuis le jeton de l'appelant.
REVOKE ALL ON FUNCTION public.claim_org_document_jobs(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_org_document_jobs(uuid, integer) TO service_role;
