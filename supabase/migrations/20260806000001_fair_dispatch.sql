-- ===== ORDONNANCEMENT ÉQUITABLE PAR ORGANISATION =====
--
-- Problème résolu : la file pgmq `document_ocr` est FIFO **globale**. Une organisation
-- qui dépose 200 factures place les documents de toutes les autres derrière les siens.
-- À 5 documents par lot et un dispatch par minute, un client qui dépose 2 factures
-- attendait 40 minutes derrière le lot d'un voisin. Aucun réglage de pgmq ne corrige
-- ça : une file FIFO ne sait pas être équitable.
--
-- Conséquence de confidentialité, jointe au même problème : un lot Anthropic construit
-- à partir d'une file globale **mélange les documents de plusieurs clients dans une
-- seule requête fournisseur**. Aucune fuite entre clients (chaque réponse est reliée à
-- sa ligne par `custom_id`, protégée par RLS), mais c'est un artefact partagé qu'on ne
-- peut ni attribuer ni auditer par client.
--
-- ── Ce que fait cette migration ──────────────────────────────────────────────────
--
-- 1. La table DEVIENT la file. `document_jobs.status = 'queued'` était déjà la source
--    de vérité — la migration d'origine le dit noir sur blanc, et le mode `direct`
--    fonctionne ainsi depuis le début, sans pgmq. pgmq n'apportait qu'une seconde
--    source de vérité à tenir synchronisée, et c'est elle qui rendait l'équité
--    impossible. Elle est retirée du chemin.
--
-- 2. Réservation en tourniquet (`claim_fair_document_jobs`) : à chaque passage, on sert
--    l'organisation **servie le moins récemment** parmi celles qui ont du travail. Un
--    client qui dépose 2 factures pendant qu'un autre en dépose 200 est servi au
--    passage suivant, pas 40 minutes plus tard.
--
-- 3. Un lot Anthropic = une seule organisation, par construction : la réservation ne
--    ramène jamais que les jobs d'une org. `document_batches.org_id` matérialise et
--    rend auditable cette garantie, avec RLS à la clé.
--
-- 4. Reprise des workers morts. pgmq assurait ça via son délai de visibilité (un
--    message non acquitté était rejoué). En le retirant il faut le remplacer, sinon un
--    worker tué en plein vol laisse ses documents bloqués pour toujours. Les trois
--    fonctions de réservation récupèrent donc les jobs figés en cours de traitement au
--    delà d'un seuil. Ça corrige au passage un trou préexistant du mode `direct` :
--    `direct_processing` n'était récupéré par personne.

-- ===== CURSEUR D'ÉQUITÉ =====
--
-- Une ligne par organisation, l'horodatage de sa dernière réservation. C'est tout ce
-- qu'il faut pour un tourniquet : on sert le plus ancien. Pas d'org_id inconnu possible
-- (clé étrangère), et la table reste minuscule — une ligne par client, à vie.
CREATE TABLE IF NOT EXISTS public.document_dispatch_cursor (
  org_id           uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  last_dispatch_at timestamptz NOT NULL DEFAULT '-infinity',
  dispatch_count   bigint NOT NULL DEFAULT 0
);

-- Aucune policy : réservé au service-role, comme les autres tables d'orchestration.
-- Les workers seuls l'écrivent, personne n'a besoin de la lire depuis le navigateur.
ALTER TABLE public.document_dispatch_cursor ENABLE ROW LEVEL SECURITY;

-- ===== INDEX =====
--
-- Le balayage de la réservation équitable porte sur « jobs batch en attente OU figés ».
-- Un index partiel par statut couvre les deux branches.
CREATE INDEX IF NOT EXISTS idx_document_jobs_batch_dispatchable
  ON public.document_jobs(org_id, queued_at)
  WHERE processing_mode = 'batch' AND status IN ('queued', 'uploading_to_claude');

CREATE INDEX IF NOT EXISTS idx_document_jobs_direct_reapable
  ON public.document_jobs(updated_at)
  WHERE processing_mode = 'direct' AND status = 'direct_processing';

-- ===== LOTS FOURNISSEUR : RATTACHEMENT À UNE ORGANISATION =====
--
-- Nullable à dessein : les lots créés AVANT cette migration mélangeaient possiblement
-- plusieurs organisations, aucune valeur ne serait honnête. Ils restent invisibles sous
-- RLS (`org_id = NULL` ne satisfait aucune policy) et ne servent plus qu'au
-- service-role. Tous les lots créés ensuite sont mono-organisation et renseignés.
ALTER TABLE public.document_batches
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.organizations(id);

COMMENT ON COLUMN public.document_batches.org_id IS
  'Organisation unique du lot. NULL = lot antérieur à l''ordonnancement équitable, potentiellement multi-organisations.';

CREATE INDEX IF NOT EXISTS idx_document_batches_org_created
  ON public.document_batches(org_id, created_at DESC);

-- Un lot est désormais attribuable : ses membres peuvent le lire. Ça permet de calculer
-- l'estimation de durée avec le client de session, sur les seuls lots de son
-- organisation, au lieu d'un agrégat inter-clients lu en service-role.
DROP POLICY IF EXISTS "org_read_document_batches" ON public.document_batches;
CREATE POLICY "org_read_document_batches" ON public.document_batches
  FOR SELECT USING (org_id IS NOT NULL AND org_id = (SELECT public.current_user_org_id()));

-- ===== RÉSERVATION ÉQUITABLE (Cron) =====

/**
 * Réserve les jobs `batch` de l'organisation servie le moins récemment.
 *
 * Le curseur est avancé AVANT la réservation, volontairement : si une invocation
 * concurrente a déjà verrouillé les lignes (`SKIP LOCKED`) et qu'on repart les mains
 * vides, l'organisation passe quand même en fin de tourniquet. Sans ça, deux workers
 * se disputeraient indéfiniment la même organisation et aucune autre ne serait servie.
 *
 * `stale_after_seconds` remplace le délai de visibilité de pgmq : un job laissé en
 * `uploading_to_claude` par un worker mort est repris au-delà de ce seuil. Le compteur
 * de tentatives étant incrémenté à chaque reprise, un job irrécupérable finit `failed`
 * au lieu de boucler.
 */
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
  -- Organisation jamais servie : `-infinity` la place en tête. `org_id` départage pour
  -- que l'ordre soit déterministe à horodatage égal.
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

-- ===== RÉSERVATION D'UNE ORGANISATION (navigateur) =====
--
-- Signature inchangée. Ajout de la reprise des jobs figés, pour que la voie navigateur
-- et la voie Cron se comportent pareil — un utilisateur qui rouvre `/upload` après un
-- worker mort débloque ses propres documents en cliquant, sans attendre le Cron.
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

-- ===== REPRISE DU MODE `direct` =====
--
-- Signature inchangée. Un job figé en `direct_processing` (worker mort, Edge Function
-- tuée pour dépassement de durée) n'était récupéré par personne : il restait
-- « Extraction en cours » à vie, non terminal, donc ni relançable ni supprimable
-- proprement par l'utilisateur. Seuil large (15 min) : le worker direct traite 10
-- documents en ~70 s, on ne veut pas repayer une extraction encore en cours.
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
DECLARE
  stale_before timestamptz := now() - interval '900 seconds';
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM public.document_jobs
    WHERE processing_mode = 'direct'
      AND (status = 'direct_queued'
           OR (status = 'direct_processing' AND updated_at < stale_before))
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

-- ===== RELANCE : PLUS DE pgmq =====
--
-- Corps identique, moins le `pgmq.send`. Remettre `status = 'queued'` suffit désormais :
-- c'est ce que la réservation équitable regarde.
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
      -- Remise à zéro : une relance manuelle redonne son quota complet de tentatives,
      -- sinon un job relancé après 3 échecs repartait déjà terminal.
      attempt_count = 0,
      updated_at = now()
  WHERE id = job_id;

  -- Valeur de retour conservée (identifiant de message pgmq à l'origine) pour ne pas
  -- casser les appelants ; il n'y a plus de message, elle vaut toujours NULL.
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.retry_document_job(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retry_document_job(uuid) TO authenticated, service_role;

-- ===== RETRAIT DE pgmq DU CHEMIN =====
--
-- ⚠️ Étape destructive, volontaire et sûre : `pgmq.drop_queue` supprime les messages en
-- attente de `document_ocr`. Ces messages ne portent QUE des `job_id` — chaque ligne
-- `document_jobs` correspondante existe toujours, avec son statut, et sera reprise par
-- `claim_fair_document_jobs`. Aucun document n'est perdu.
--
-- Laisser la file en place serait le vrai risque : plus personne ne la lirait, elle
-- grossirait indéfiniment, et deux sources de vérité contradictoires subsisteraient.
DROP FUNCTION IF EXISTS public.enqueue_document_job(uuid);
DROP FUNCTION IF EXISTS public.claim_document_jobs(integer, integer);
DROP FUNCTION IF EXISTS public.acknowledge_document_job(bigint);

DO $$
BEGIN
  PERFORM pgmq.drop_queue('document_ocr');
EXCEPTION
  -- File déjà absente (rollback partiel, base neuve) : rien à faire.
  WHEN undefined_table THEN NULL;
  WHEN undefined_function THEN NULL;
  WHEN others THEN
    RAISE WARNING 'pgmq.drop_queue(document_ocr) ignoré : %', SQLERRM;
END $$;
