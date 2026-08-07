-- Rollback de 20260806000007_studio_default_columns.sql
--
-- Purement cosmétique, aucune dépendance applicative : aucun code du dépôt ne lit
-- `invoice_tags.id`, `invoice_tags.created_at`, `invoice_charges.created_at`,
-- `corrections_log.created_at` ni `anomalies.created_at` (elles n'existaient d'ailleurs
-- pas avant cette migration). Le rollback fait juste réapparaître le bruit Studio.

ALTER TABLE public.anomalies        DROP COLUMN IF EXISTS created_at;
ALTER TABLE public.corrections_log  DROP COLUMN IF EXISTS created_at;
ALTER TABLE public.invoice_charges  DROP COLUMN IF EXISTS created_at;
ALTER TABLE public.invoice_tags     DROP COLUMN IF EXISTS created_at;
ALTER TABLE public.invoice_tags     DROP COLUMN IF EXISTS id;
