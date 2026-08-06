-- Rollback de 20260806000004_org_scoped_anomaly_recompute.sql
--
-- ⚠️ Redéployer d'abord l'application dans sa version précédente : `lib/anomalies/
-- persist.ts` appelle ces trois fonctions, chaque recalcul échouerait entre les deux.
--
-- ⚠️ Effet : le recalcul retransporte la liste complète des identifiants de factures
-- dans l'URL. Au-delà d'environ 200 factures par organisation, `/api/invoices` POST
-- (enregistrement après révision) et le Cron d'enregistrement automatique répondent 414
-- ou 400. C'est précisément la limite que cette migration supprime.

DROP FUNCTION IF EXISTS public.delete_org_recomputed_anomalies(uuid, text[]);
DROP FUNCTION IF EXISTS public.org_recomputed_anomalies(uuid, text[], integer, integer);
DROP FUNCTION IF EXISTS public.org_anomaly_periods(uuid, integer, integer);
DROP FUNCTION IF EXISTS public.assert_org_access(uuid);

-- Les deux index sont conservés : purement additifs, ils accélèrent aussi les
-- jointures `anomalies → invoices` du reste de l'application.
