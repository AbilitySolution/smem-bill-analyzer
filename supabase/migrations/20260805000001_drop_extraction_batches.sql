-- ===== RETRAIT DE L'IMPORT EN LOT PAR ARCHIVE ZIP =====
--
-- `extraction_batches` / `extraction_batch_items` (20260803000000) sont remplacés par
-- la file `document_jobs` (migration précédente), qui couvre le même besoin — l'API
-- Message Batches — et y ajoute le mode direct, le pré-filtrage et la reprise par Cron.
--
-- ⚠️ DESTRUCTIF. À exécuter seulement une fois qu'aucun lot n'est en vol :
--
--     SELECT status, count(*) FROM extraction_batches
--     WHERE status IN ('preparing','submitted','importing') GROUP BY status;
--
-- doit renvoyer 0 ligne. Un lot `submitted` supprimé ici continue de tourner chez
-- Anthropic : ses résultats ne seront jamais importés, et les fichiers correspondants
-- restent dans le bucket `invoice-files`. Les factures déjà créées ne sont pas
-- touchées (`extraction_batch_items.invoice_id` est un lien sortant, pas une
-- dépendance des factures).

DROP TABLE IF EXISTS public.extraction_batch_items;
DROP TABLE IF EXISTS public.extraction_batches;
