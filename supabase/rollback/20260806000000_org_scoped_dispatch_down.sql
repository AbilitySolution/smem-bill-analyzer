-- Rollback de 20260806000000_org_scoped_dispatch.sql
--
-- ⚠️ Redéployer `process-document-queue` dans sa version pgmq-uniquement AVANT
-- d'appliquer ce rollback : la version org-scopée appelle `claim_org_document_jobs`
-- pour les appels utilisateur et échouerait en 500 si la fonction disparaît.
--
-- Après rollback, tout utilisateur authentifié redevient capable de déclencher le
-- dispatch de la file globale, toutes organisations confondues.

DROP FUNCTION IF EXISTS public.claim_org_document_jobs(uuid, integer);
DROP INDEX IF EXISTS public.idx_document_jobs_batch_pending;
