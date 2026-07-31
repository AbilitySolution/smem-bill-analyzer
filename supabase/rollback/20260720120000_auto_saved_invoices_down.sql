-- ROLLBACK 1/6 — annule 20260720120000_auto_saved_invoices.sql
-- Destructif : perte définitive du marqueur « enregistrée automatiquement ».
-- Seul rollback de la série sûr à exécuter à chaud (additif, isolé, sans dépendance).

-- Conserver la liste des factures auto-enregistrées avant de supprimer la colonne :
--   create table if not exists _backup_auto_saved_invoices as
--   select id from public.invoices where auto_saved;

ALTER TABLE public.invoices DROP COLUMN IF EXISTS auto_saved;
