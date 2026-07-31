-- ROLLBACK 6/6 — annule 20260715000000_document_queue.sql
--
-- 🔴 ROLLBACK TOTAL — SUPPRIME LA FILE ET TOUS LES JOBS.
-- À n'exécuter que pour un retrait complet de la fonctionnalité.
-- En cas d'incident, s'arrêter au rollback 5 : la file batch simple reste fonctionnelle.

-- ⚠️ PRÉALABLE OBLIGATOIRE — aucun job non terminal ne doit subsister :
--   select status, count(*) from public.document_jobs
--   where status not in ('completed','failed','rejected_non_invoice')
--   group by status;
-- Doit renvoyer 0 ligne. Sinon : documents définitivement perdus pour l'utilisateur.
--
-- ⚠️ Sauvegarder avant de dérouler :
--   create table if not exists _backup_document_jobs as select * from public.document_jobs;
--
-- ⚠️ Fichiers orphelins — les objets du bucket « invoice-files » sous <user_id>/queue/
-- ne sont PAS supprimés par ce script. Les lister avant purge :
--   select file_path from public.document_jobs;

-- 1. Couper le Cron AVANT tout DROP.
DO $$
DECLARE existing_job bigint;
BEGIN
  FOR existing_job IN
    SELECT jobid FROM cron.job
    WHERE jobname IN ('process-document-ocr-queue','dispatch-claude-batches',
                      'collect-claude-batches','process-direct-documents')
  LOOP
    PERFORM cron.unschedule(existing_job);
  END LOOP;
END $$;

BEGIN;

-- 2. Retirer de la publication Realtime avant le DROP TABLE.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime DROP TABLE public.document_jobs;
EXCEPTION
  WHEN undefined_object THEN NULL;
  WHEN undefined_table  THEN NULL;
END $$;

-- 3. Supprimer les fonctions (toutes signatures de la série).
DROP FUNCTION IF EXISTS public.enqueue_document_job(uuid);
DROP FUNCTION IF EXISTS public.retry_document_job(uuid);
DROP FUNCTION IF EXISTS public.claim_document_job(integer);
DROP FUNCTION IF EXISTS public.claim_document_jobs(integer, integer);
DROP FUNCTION IF EXISTS public.claim_direct_document_jobs(uuid[], uuid, integer);
DROP FUNCTION IF EXISTS public.acknowledge_document_job(bigint);

-- 4. Supprimer les tables.
DROP TABLE IF EXISTS public.document_batches;
DROP TABLE IF EXISTS public.document_jobs;

COMMIT;

-- 5. Supprimer la file pgmq (hors transaction : pgmq.drop_queue gère ses propres DDL).
DO $$
BEGIN
  PERFORM pgmq.drop_queue('document_ocr');
EXCEPTION
  WHEN undefined_function THEN NULL;  -- extension déjà retirée
  WHEN OTHERS THEN RAISE NOTICE 'drop_queue(document_ocr) : %', SQLERRM;
END $$;

-- 6. Extensions — NE PAS supprimer par défaut.
-- pg_cron, pg_net et pgmq peuvent être utilisées par d'autres fonctionnalités.
-- Vérifier avant tout DROP EXTENSION :
--   select jobname from cron.job;                 -- doit être vide
--   select queue_name from pgmq.list_queues();    -- doit être vide
-- Puis, seulement si les deux sont vides :
--   DROP EXTENSION IF EXISTS pgmq;
--   DROP EXTENSION IF EXISTS pg_cron;
--   DROP EXTENSION IF EXISTS pg_net;

-- 7. Retirer les Edge Functions (hors SQL) :
--   npx supabase functions delete process-document-queue   --project-ref <REF>
--   npx supabase functions delete collect-document-batches --project-ref <REF>
--   npx supabase functions delete process-direct-documents --project-ref <REF>
--
-- 8. Secrets Vault — les conserver si d'autres Cron les utilisent, sinon :
--   delete from vault.secrets where name in ('project_url','service_role_key');
