-- Rollback de 20260805000000_document_queue.sql
--
-- 🔴 DESTRUCTIF — supprime toute la file de traitement.
-- Lire `supabase/rollback/README.md` avant : les Cron doivent être désactivés et la
-- file vidangée, sinon des documents sont perdus avec leurs fichiers orphelins.

-- 1. Cron d'abord : plus aucun appel vers des Edge Functions qui écriraient dans des
--    tables en cours de suppression.
DO $$
DECLARE existing_job bigint;
BEGIN
  FOR existing_job IN
    SELECT jobid FROM cron.job
    WHERE jobname IN ('dispatch-claude-batches','collect-claude-batches','process-direct-documents')
  LOOP
    PERFORM cron.unschedule(existing_job);
  END LOOP;
END $$;

-- 2. Realtime.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime DROP TABLE public.document_jobs;
EXCEPTION
  WHEN undefined_object THEN NULL;
END $$;

-- 3. Fonctions.
DROP FUNCTION IF EXISTS public.acknowledge_document_job(bigint);
DROP FUNCTION IF EXISTS public.claim_direct_document_jobs(uuid[], uuid, integer);
DROP FUNCTION IF EXISTS public.claim_document_jobs(integer, integer);
DROP FUNCTION IF EXISTS public.retry_document_job(uuid);
DROP FUNCTION IF EXISTS public.enqueue_document_job(uuid);

-- 4. Tables et file.
DROP TABLE IF EXISTS public.document_batches;
DROP TABLE IF EXISTS public.document_jobs;

DO $$
BEGIN
  PERFORM pgmq.drop_queue('document_ocr');
EXCEPTION
  WHEN undefined_table THEN NULL;
  WHEN undefined_function THEN NULL;
END $$;

-- 5. Marqueur d'enregistrement automatique.
--    Commenter cette ligne pour conserver l'historique des factures auto-enregistrées.
ALTER TABLE public.invoices DROP COLUMN IF EXISTS auto_saved;

-- 6. Types MIME du bucket, tels qu'avant la migration (sans WEBP).
UPDATE storage.buckets
SET allowed_mime_types = ARRAY['application/pdf','image/jpeg','image/png','image/tiff']
WHERE id = 'invoice-files';

-- Les extensions pgmq / pg_cron / pg_net ne sont PAS supprimées : elles peuvent servir
-- ailleurs, et un DROP EXTENSION casserait tout autre usage.
