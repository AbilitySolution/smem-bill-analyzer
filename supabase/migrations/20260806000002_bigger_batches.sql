-- ===== LOTS FOURNISSEUR PLUS GROS + COLLECTE ÉQUITABLE =====
--
-- ── 1. Plafond de réservation ────────────────────────────────────────────────────
--
-- Les deux fonctions de réservation bornaient à 10 documents (`LEAST(..., 10)`), et le
-- worker demandait 5. Un lot Anthropic contenait donc 5 documents, alors que l'API
-- Batches en accepte des dizaines de milliers.
--
-- Conséquence sur le débit : 2 000 documents = 400 lots. Le collecteur en visite 10 par
-- minute → 40 minutes rien que pour les regarder une fois. Le 5 protégeait la
-- *préparation* (un téléchargement + un upload + une classification par document dans
-- l'Edge Function), pas le lot lui-même. Les deux sont désormais découplés : le worker
-- borne son travail au nombre de documents préparés par invocation, et regroupe tout ce
-- qu'il prépare pour une organisation dans UN seul lot.
--
-- 2 000 documents passent ainsi de 400 lots à ~40.
--
-- ── 2. Équité à la collecte ──────────────────────────────────────────────────────
--
-- Le collecteur lisait `ORDER BY created_at LIMIT 10` : FIFO strict, exactement le
-- couplage entre clients corrigé côté dispatch mais laissé côté collecte. Un client
-- dont les lots sont les plus récents attendait derrière tous ceux des autres.

-- Plafond commun aux deux réservations. Aligné sur ce qu'une invocation d'Edge Function
-- peut préparer, pas sur ce que l'API Batches accepte.
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

  IF target_org IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.document_dispatch_cursor AS cursor_row (org_id, last_dispatch_at, dispatch_count)
  VALUES (target_org, now(), 1)
  ON CONFLICT (org_id) DO UPDATE
    SET last_dispatch_at = now(),
        dispatch_count = cursor_row.dispatch_count + 1;

  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM public.document_jobs
    WHERE processing_mode = 'batch'
      AND org_id = target_org
      AND (status = 'queued'
           OR (status = 'uploading_to_claude' AND updated_at < stale_before))
    ORDER BY queued_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(job_limit, 1), 100)
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
    SELECT id
    FROM public.document_jobs
    WHERE processing_mode = 'batch'
      AND org_id = requested_org_id
      AND (status = 'queued'
           OR (status = 'uploading_to_claude' AND updated_at < stale_before))
    ORDER BY queued_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(job_limit, 1), 100)
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

/**
 * Lots à collecter, en tourniquet par organisation.
 *
 * `row_number()` par organisation puis tri sur ce rang : on prend d'abord le lot le plus
 * ancien de CHAQUE organisation, puis le deuxième de chacune, etc. Un client qui a 40
 * lots en cours ne peut donc plus occuper les 10 places d'un tick.
 *
 * Fonction plutôt que requête directe : PostgREST ne sait pas exprimer une fonction de
 * fenêtrage. Les lots antérieurs à l'ordonnancement équitable (`org_id IS NULL`,
 * potentiellement multi-organisations) sont traités comme un groupe à part et restent
 * collectés — ils ne doivent pas rester en `in_progress` pour l'éternité.
 */
CREATE OR REPLACE FUNCTION public.list_batches_to_collect(batch_limit integer DEFAULT 10)
RETURNS SETOF public.document_batches
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  -- Sélection des identifiants d'abord : `SETOF document_batches` impose de renvoyer
  -- exactement les colonnes de la table, `rank_in_org` ne peut donc pas remonter.
  SELECT batch.*
  FROM public.document_batches AS batch
  WHERE batch.id IN (
    SELECT ranked.id
    FROM (
      SELECT
        candidate.id,
        candidate.created_at,
        row_number() OVER (
          PARTITION BY COALESCE(candidate.org_id, '00000000-0000-0000-0000-000000000000'::uuid)
          ORDER BY candidate.created_at
        ) AS rank_in_org
      FROM public.document_batches AS candidate
      WHERE candidate.status = 'in_progress'
    ) AS ranked
    ORDER BY ranked.rank_in_org, ranked.created_at
    LIMIT LEAST(GREATEST(batch_limit, 1), 50)
  );
$$;

REVOKE ALL ON FUNCTION public.list_batches_to_collect(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_batches_to_collect(integer) TO service_role;
