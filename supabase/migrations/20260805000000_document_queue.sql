-- ===== FILE DE TRAITEMENT DOCUMENTAIRE (document_jobs) =====
--
-- Remplace l'import en lot par archive ZIP (`extraction_batches`, supprimé par la
-- migration suivante) par une file durable côté base de données.
--
-- Principe directeur : **l'état métier vit dans public.document_jobs ; pgmq ne
-- transporte que des identifiants de job.** Un message pgmq perdu ne perd donc jamais
-- de document — la ligne reste en base et reste relançable.
--
-- Deux modes de traitement, choisis par l'appelant à l'import et figés sur le job :
--
--   direct : API Messages synchrone, quelques secondes, plein tarif, petits imports.
--            queued=direct_queued → direct_processing → needs_review
--   batch  : API Message Batches asynchrone, minutes à heures, tarif réduit (−50 %).
--            queued → uploading_to_claude → batched → needs_review
--            (seul ce mode passe par pgmq)
--
-- Consolidation des 6 migrations de la branche `staging` (20260715 → 20260720) en un
-- seul fichier, adapté au schéma multi-tenant appliqué depuis (`20260729000000`) :
--   - `org_id NOT NULL` + RLS par organisation (staging isolait par utilisateur) ;
--   - `is_org_admin()` remplace `is_admin_smem()`, qui n'existe plus ;
--   - horodatage postérieur à la dernière migration appliquée (20260803000000).
--
-- Infrastructure requise APRÈS `db push` (voir README) :
--   1. secrets Vault `project_url` et `service_role_key` — sans eux les Cron ne font
--      RIEN, silencieusement ;
--   2. `supabase functions deploy` des 3 Edge Functions ;
--   3. secret `ANTHROPIC_API_KEY` sur les Edge Functions.

CREATE EXTENSION IF NOT EXISTS pgmq;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  PERFORM pgmq.create('document_ocr');
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN unique_violation THEN NULL;
END $$;

-- ===== TABLE =====

CREATE TABLE IF NOT EXISTS public.document_jobs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Dénormalisé comme partout ailleurs dans ce schéma : permet une policy RLS directe
  -- sans jointure. C'est ce qui manquait à la version `staging`.
  org_id                  uuid NOT NULL REFERENCES public.organizations(id),
  created_by              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_path               text NOT NULL,
  original_name           text NOT NULL,
  mime_type               text NOT NULL,
  file_size               bigint NOT NULL CHECK (file_size > 0 AND file_size <= 20971520),
  processing_mode         text NOT NULL DEFAULT 'batch'
                          CHECK (processing_mode IN ('direct', 'batch')),
  status                  text NOT NULL DEFAULT 'queued'
                          CHECK (status IN (
                            'direct_queued', 'direct_processing',
                            'queued', 'uploading_to_claude', 'batched', 'processing',
                            'needs_review', 'completed', 'failed', 'rejected_non_invoice'
                          )),
  attempt_count           integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  extraction_json         jsonb,
  validation_json         jsonb,
  suggested_commune_id    uuid REFERENCES public.communes(id) ON DELETE SET NULL,
  suggested_site_id       uuid REFERENCES public.sites(id) ON DELETE SET NULL,
  processed_invoice_id    uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  last_error              text,
  -- Identifiants côté fournisseur, remis à NULL dès que le fichier distant est supprimé.
  anthropic_file_id       text,
  anthropic_batch_id      text,
  -- Pré-filtrage : type détecté quand le document est rejeté, et dérogation posée par
  -- une relance manuelle (« traiter quand même »).
  prefilter_type          text,
  skip_prefilter          boolean NOT NULL DEFAULT false,
  -- Instrumentation de bout en bout : permet de mesurer chaque étape (mise en file →
  -- dispatch → upload → création du lot → résultat disponible).
  queued_at               timestamptz NOT NULL DEFAULT now(),
  dispatch_started_at     timestamptz,
  claude_file_uploaded_at timestamptz,
  batch_created_at        timestamptz,
  result_available_at     timestamptz,
  started_at              timestamptz,
  completed_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_jobs_prefilter_type_check
    CHECK (prefilter_type IS NULL OR prefilter_type IN ('facture', 'bordereau_recapitulatif', 'autre'))
);

CREATE INDEX IF NOT EXISTS idx_document_jobs_org_created_at
  ON public.document_jobs(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_jobs_created_by_created_at
  ON public.document_jobs(created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_jobs_status_created_at
  ON public.document_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_document_jobs_anthropic_batch
  ON public.document_jobs(anthropic_batch_id);

-- Index partiels, très sélectifs : ce sont les deux seuls balayages des workers.
CREATE INDEX IF NOT EXISTS idx_document_jobs_direct_pending
  ON public.document_jobs(status, queued_at)
  WHERE processing_mode = 'direct' AND status = 'direct_queued';

ALTER TABLE public.document_jobs ENABLE ROW LEVEL SECURITY;

-- Lecture par organisation, comme `invoices` : deux membres d'une même org voient la
-- même file. Aucune policy d'écriture : les routes API écrivent via le client
-- service-role, qui contourne la RLS. C'est intentionnel — un job ne doit jamais
-- pouvoir changer de statut depuis le navigateur.
DROP POLICY IF EXISTS "org_read_document_jobs" ON public.document_jobs;
CREATE POLICY "org_read_document_jobs" ON public.document_jobs
  FOR SELECT USING (org_id = (SELECT public.current_user_org_id()));

-- ===== LOTS FOURNISSEUR =====
--
-- Un lot Anthropic peut agréger des jobs de plusieurs organisations (le worker
-- consomme une file globale). La table ne porte donc pas d'`org_id` et n'expose
-- AUCUNE policy : elle est réservée au service-role. Les compteurs agrégés servent
-- l'estimation de durée, calculée côté serveur avec le client admin.

CREATE TABLE IF NOT EXISTS public.document_batches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anthropic_batch_id    text NOT NULL UNIQUE,
  status                text NOT NULL DEFAULT 'in_progress'
                        CHECK (status IN ('in_progress','ended','failed')),
  document_count        integer NOT NULL CHECK (document_count > 0),
  request_counts        jsonb,
  last_error            text,
  dispatch_started_at   timestamptz,
  anthropic_ended_at    timestamptz,
  collection_started_at timestamptz,
  result_available_at   timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_batches_status
  ON public.document_batches(status, created_at);

ALTER TABLE public.document_batches ENABLE ROW LEVEL SECURITY;

-- ===== FONCTIONS =====
--
-- Toutes en SECURITY DEFINER avec `search_path` figé, `REVOKE ALL` avant `GRANT`.

/**
 * Met un job en file pgmq. Autorisé au service-role, ou à un membre de l'organisation
 * du job (l'auteur, ou un administrateur d'organisation).
 */
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
  FROM public.document_jobs
  WHERE id = job_id;

  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'Document job not found';
  END IF;

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

/**
 * Relance un job terminal.
 *
 * Un job `rejected_non_invoice` relancé pose `skip_prefilter` : l'utilisateur a jugé
 * que le pré-filtre s'était trompé, on force l'extraction complète sans repasser par
 * le classifieur. Un job `failed` repart au début de son mode d'origine.
 */
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

/**
 * Réservation des jobs `batch`. Enveloppe `pgmq.read` pour garder le schéma pgmq hors
 * de la Data API. La visibilité (défaut 300 s) rejoue automatiquement un message non
 * acquitté : un worker tué en plein vol ne perd pas ses documents.
 */
CREATE OR REPLACE FUNCTION public.claim_document_jobs(
  visibility_timeout_seconds integer DEFAULT 300,
  message_limit integer DEFAULT 5
)
RETURNS TABLE(message_id bigint, job_id uuid, read_count integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
  SELECT
    message.msg_id,
    (message.message->>'job_id')::uuid,
    message.read_ct
  FROM pgmq.read(
    'document_ocr',
    GREATEST(visibility_timeout_seconds, 60),
    LEAST(GREATEST(message_limit, 1), 10)
  ) AS message;
$$;

REVOKE ALL ON FUNCTION public.claim_document_jobs(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_document_jobs(integer, integer) TO service_role;

/**
 * Réservation des jobs `direct`. `FOR UPDATE SKIP LOCKED` + passage atomique en
 * `direct_processing` : deux invocations concurrentes ne peuvent pas réserver le même
 * job. `requested_owner_id` restreint au demandeur quand la fonction est appelée avec
 * un jeton utilisateur (démarrage immédiat depuis la page d'import).
 */
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
    SELECT id
    FROM public.document_jobs
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

-- ===== FACTURES ENREGISTRÉES AUTOMATIQUEMENT =====
-- Marqueur des factures créées sans relecture humaine (extraction ET rapprochement de
-- commune au-dessus du seuil de confiance). Sert à les distinguer dans Mes documents.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS auto_saved boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.invoices.auto_saved IS
  'Facture créée automatiquement par la file de traitement, sans relecture humaine préalable.';

-- ===== REALTIME =====
-- La page d'import suit la progression par Realtime plutôt qu'en sondant. Encadré :
-- `ALTER PUBLICATION ... ADD TABLE` échoue en 42710 si la table y est déjà.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.document_jobs;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ===== STORAGE =====
-- Le bucket n'acceptait pas WEBP alors que l'extraction sait le lire.
UPDATE storage.buckets
SET allowed_mime_types = ARRAY['application/pdf','image/jpeg','image/png','image/tiff','image/webp']
WHERE id = 'invoice-files';

-- ===== CRON =====
--
-- Filet de sécurité : les workers sont aussi invoqués directement par le navigateur au
-- dépôt, pour ne pas attendre le tick suivant. Ces trois jobs garantissent que le
-- traitement continue si l'utilisateur ferme l'onglet.
--
-- ⚠️ Sans les secrets Vault `project_url` et `service_role_key`, les sous-requêtes ne
-- renvoient aucune ligne : `net.http_post` n'est jamais appelé et l'échec est SILENCIEUX.
DO $$
DECLARE existing_job bigint;
BEGIN
  FOR existing_job IN
    SELECT jobid FROM cron.job
    WHERE jobname IN (
      'process-document-ocr-queue', 'dispatch-claude-batches',
      'collect-claude-batches', 'process-direct-documents'
    )
  LOOP
    PERFORM cron.unschedule(existing_job);
  END LOOP;

  PERFORM cron.schedule(
    'dispatch-claude-batches', '* * * * *',
    $cron$
      SELECT net.http_post(
        url := project_url.secret || '/functions/v1/process-document-queue',
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || service_key.secret),
        body := '{}'::jsonb
      )
      FROM
        (SELECT decrypted_secret AS secret FROM vault.decrypted_secrets WHERE name='project_url' LIMIT 1) project_url,
        (SELECT decrypted_secret AS secret FROM vault.decrypted_secrets WHERE name='service_role_key' LIMIT 1) service_key;
    $cron$
  );

  PERFORM cron.schedule(
    'collect-claude-batches', '* * * * *',
    $cron$
      SELECT net.http_post(
        url := project_url.secret || '/functions/v1/collect-document-batches',
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || service_key.secret),
        body := '{}'::jsonb
      )
      FROM
        (SELECT decrypted_secret AS secret FROM vault.decrypted_secrets WHERE name='project_url' LIMIT 1) project_url,
        (SELECT decrypted_secret AS secret FROM vault.decrypted_secrets WHERE name='service_role_key' LIMIT 1) service_key;
    $cron$
  );

  PERFORM cron.schedule(
    'process-direct-documents', '* * * * *',
    $cron$
      SELECT net.http_post(
        url := project_url.secret || '/functions/v1/process-direct-documents',
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || service_key.secret),
        body := '{}'::jsonb
      )
      FROM
        (SELECT decrypted_secret AS secret FROM vault.decrypted_secrets WHERE name='project_url' LIMIT 1) project_url,
        (SELECT decrypted_secret AS secret FROM vault.decrypted_secrets WHERE name='service_role_key' LIMIT 1) service_key;
    $cron$
  );
END $$;
