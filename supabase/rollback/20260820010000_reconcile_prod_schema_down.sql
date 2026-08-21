-- Rollback de 20260820010000_reconcile_prod_schema.sql
--
-- Ramène le schéma à la forme qu'avait la production avant réconciliation. C'est un
-- retour en arrière VERS un état incohérent, pas vers un état sain : la prod y redevient
-- différente de ce que produisent les migrations, et le bug d'origine revient avec elle.
--
-- 🔴 `pending_uploads.status` redevient `processed boolean`. Trois chemins de code lisent
--    ou écrivent `status` :
--      app/api/pending/route.ts, app/(app)/parametres/demandes/page.tsx,
--      app/api/pending/[id]/route.ts
--    Jouer ce rollback SANS redéployer une version du code antérieure à ces appels
--    remet la page « Demandes de fichier » en panne. C'est précisément l'état dans lequel
--    la production se trouvait avant le 2026-08-20.
--
-- 🟠 Les états intermédiaires 'processing' et 'error' n'ont pas d'équivalent booléen :
--    ils retombent sur `processed = false`, au même titre que 'pending'. L'information
--    est perdue et non reconstituable. Relever le contenu de la colonne avant d'exécuter
--    si la table n'est plus vide.
--
-- Le reste (NOT NULL, noms d'index, sens de tri) se défait sans perte.

BEGIN;

-- 4. Index de date : retour en ASC
DROP INDEX IF EXISTS public.idx_invoices_facture_date;
CREATE INDEX idx_invoices_facture_date ON public.invoices USING btree (facture_date);

-- 3. consumption_periods : retour aux noms hérités et à l'index en double
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'consumption_periods_pkey'
      AND conrelid = 'public.consumption_periods'::regclass
  ) THEN
    ALTER TABLE public.consumption_periods
      RENAME CONSTRAINT consumption_periods_pkey TO invoice_consumption_lines_pkey;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_consumption_lines_invoice
  ON public.consumption_periods USING btree (invoice_id);

-- 2. NOT NULL : retour à la permissivité de la prod
ALTER TABLE public.activities          ALTER COLUMN created_at    DROP NOT NULL;
ALTER TABLE public.anomalies           ALTER COLUMN detected_at   DROP NOT NULL;
ALTER TABLE public.anomalies           ALTER COLUMN resolved      DROP NOT NULL;
ALTER TABLE public.clients             ALTER COLUMN created_at    DROP NOT NULL;
ALTER TABLE public.communes            ALTER COLUMN created_at    DROP NOT NULL;
ALTER TABLE public.consumption_periods ALTER COLUMN coefficient   DROP NOT NULL;
ALTER TABLE public.consumption_periods ALTER COLUMN index_estime  DROP NOT NULL;
ALTER TABLE public.consumption_periods ALTER COLUMN invoice_id    DROP NOT NULL;
ALTER TABLE public.contracts           ALTER COLUMN created_at    DROP NOT NULL;
ALTER TABLE public.corrections_log     ALTER COLUMN corrected_at  DROP NOT NULL;
ALTER TABLE public.corrections_log     ALTER COLUMN invoice_id    DROP NOT NULL;
ALTER TABLE public.file_request_links  ALTER COLUMN created_at    DROP NOT NULL;
ALTER TABLE public.invoice_charges     ALTER COLUMN invoice_id    DROP NOT NULL;
ALTER TABLE public.invoices            ALTER COLUMN created_at    DROP NOT NULL;
ALTER TABLE public.invoices            ALTER COLUMN is_duplicata  DROP NOT NULL;
ALTER TABLE public.sites               ALTER COLUMN created_at    DROP NOT NULL;
ALTER TABLE public.tags                ALTER COLUMN created_at    DROP NOT NULL;
ALTER TABLE public.user_roles          ALTER COLUMN created_at    DROP NOT NULL;

-- `communes.travaux_estimes` n'est PAS remis en NULL-able : la production l'avait déjà
-- NOT NULL DEFAULT false avant cette migration. Le relâcher irait plus loin que le
-- rollback et ferait diverger la prod dans l'autre sens.

-- 1. pending_uploads : retour à `processed boolean`
ALTER TABLE public.pending_uploads DROP CONSTRAINT IF EXISTS pending_uploads_status_check;
ALTER TABLE public.pending_uploads DROP CONSTRAINT IF EXISTS pending_uploads_processed_invoice_id_fkey;

ALTER TABLE public.pending_uploads ADD COLUMN IF NOT EXISTS processed boolean DEFAULT false;
UPDATE public.pending_uploads SET processed = (status = 'done');

ALTER TABLE public.pending_uploads DROP COLUMN IF EXISTS status;
ALTER TABLE public.pending_uploads DROP COLUMN IF EXISTS processed_invoice_id;

ALTER TABLE public.pending_uploads ALTER COLUMN original_name DROP NOT NULL;
ALTER TABLE public.pending_uploads ALTER COLUMN created_at    DROP NOT NULL;

-- La clé étrangère redevient sans ON DELETE : supprimer un lien de demande refuse alors
-- de s'exécuter tant qu'un dépôt le référence.
ALTER TABLE public.pending_uploads DROP CONSTRAINT IF EXISTS pending_uploads_file_request_link_id_fkey;
ALTER TABLE public.pending_uploads ADD CONSTRAINT pending_uploads_file_request_link_id_fkey
  FOREIGN KEY (file_request_link_id) REFERENCES public.file_request_links(id);

COMMIT;
