-- Réconciliation du schéma de production avec les migrations.
--
-- Constat du 2026-08-20 : une base reconstruite depuis `supabase/migrations/` ne donne pas
-- le même schéma que la production. Les migrations ne sont donc pas, aujourd'hui, une
-- description fidèle de ce qui tourne — ce qui rend tout environnement de développement
-- créé à partir d'elles structurellement différent de la prod.
--
-- Origine : le squash `20260704050000` décrit un état CIBLE ; la production, elle, n'a
-- jamais été reconstruite depuis ce squash. Elle a continué sur ses objets d'origine, avec
-- les noms et les contraintes hérités d'avant. Les écarts se sont accumulés sans bruit.
--
-- Écarts mesurés (comparaison colonne à colonne, contrainte à contrainte, index à index
-- entre la prod et un `supabase db reset` local) :
--
--   1. `pending_uploads` porte en prod la génération précédente de la table : colonne
--      `processed boolean` au lieu de `status text`, pas de `processed_invoice_id`, et
--      deux clés étrangères sans `ON DELETE`. C'est le seul écart à conséquence
--      fonctionnelle, et elle est réelle : trois chemins de code interrogent
--      `pending_uploads.status`, qui n'existe pas en production.
--        app/api/pending/route.ts                  -> .eq("status", "pending")
--        app/(app)/parametres/demandes/page.tsx    -> .eq("status", "pending")
--        app/api/pending/[id]/route.ts             -> .update({ status: ... })
--      La page « Demandes de fichier » ne peut donc rien lister en prod. La table y est
--      vide (0 ligne), la bascule de colonne ne déplace aucune donnée.
--
--   2. 21 colonnes NOT NULL dans les migrations sont NULL-ables en prod, et 2 le sont dans
--      l'autre sens. Aucune ligne NULL nulle part (compté table par table avant d'écrire
--      cette migration) : les contraintes se posent sans reprise de données. Sans effet
--      visible aujourd'hui, mais c'est ce qui fait diverger silencieusement une base de dev.
--
--   3. `consumption_periods` garde en prod la clé primaire et un index au nom de l'ancienne
--      table `invoice_consumption_lines` — renommée sans que ses objets suivent. D'où un
--      index en double : `idx_consumption_lines_invoice` et `idx_consumption_periods_invoice`
--      couvrent la même colonne.
--
--   4. `idx_invoices_facture_date` est ASC en prod, DESC dans les migrations. Les listes
--      sont triées par date décroissante : c'est la version DESC qui sert.
--
-- Sur une base neuve, tout ce fichier est un no-op : chaque instruction est conditionnée à
-- l'état antérieur. C'est la condition pour qu'il reste rejouable et que `db reset` continue
-- de produire exactement le schéma de production.

BEGIN;

-- ============================================================
-- 1. pending_uploads : `processed` (booléen) -> `status` (état)
-- ============================================================

ALTER TABLE public.pending_uploads ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.pending_uploads ADD COLUMN IF NOT EXISTS processed_invoice_id uuid;

-- Report de l'ancien booléen, puis retrait. `processed = true` ne dit rien de plus que
-- « traité » : il devient 'done', et tout le reste 'pending'.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pending_uploads' AND column_name = 'processed'
  ) THEN
    UPDATE public.pending_uploads
       SET status = CASE WHEN processed THEN 'done' ELSE 'pending' END
     WHERE status IS NULL;
    ALTER TABLE public.pending_uploads DROP COLUMN processed;
  END IF;
END $$;

UPDATE public.pending_uploads SET status = 'pending' WHERE status IS NULL;

ALTER TABLE public.pending_uploads ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE public.pending_uploads ALTER COLUMN status SET NOT NULL;

ALTER TABLE public.pending_uploads DROP CONSTRAINT IF EXISTS pending_uploads_status_check;
ALTER TABLE public.pending_uploads ADD CONSTRAINT pending_uploads_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'processing'::text, 'done'::text, 'error'::text]));

-- Le dépôt public (app/api/depot/[token]/route.ts) renseigne toujours ces deux colonnes
-- depuis le lien de demande : la prod a raison de les exiger, les migrations avaient tort.
ALTER TABLE public.pending_uploads ALTER COLUMN commune_id    SET NOT NULL;
ALTER TABLE public.pending_uploads ALTER COLUMN original_name SET NOT NULL;
ALTER TABLE public.pending_uploads ALTER COLUMN created_at    SET NOT NULL;

-- Supprimer une facture ou un lien de demande ne doit pas emporter le dépôt en attente :
-- la référence est vidée, la ligne reste.
ALTER TABLE public.pending_uploads DROP CONSTRAINT IF EXISTS pending_uploads_processed_invoice_id_fkey;
ALTER TABLE public.pending_uploads ADD CONSTRAINT pending_uploads_processed_invoice_id_fkey
  FOREIGN KEY (processed_invoice_id) REFERENCES public.invoices(id) ON DELETE SET NULL;

ALTER TABLE public.pending_uploads DROP CONSTRAINT IF EXISTS pending_uploads_file_request_link_id_fkey;
ALTER TABLE public.pending_uploads ADD CONSTRAINT pending_uploads_file_request_link_id_fkey
  FOREIGN KEY (file_request_link_id) REFERENCES public.file_request_links(id) ON DELETE SET NULL;

-- ============================================================
-- 2. NOT NULL : alignement sur les migrations
-- ============================================================
-- Toutes ces colonnes ont un DEFAULT ou sont systématiquement renseignées par le code, et
-- aucune ne contient de NULL en production.

ALTER TABLE public.activities          ALTER COLUMN created_at    SET NOT NULL;
ALTER TABLE public.anomalies           ALTER COLUMN detected_at   SET NOT NULL;
ALTER TABLE public.anomalies           ALTER COLUMN resolved      SET NOT NULL;
ALTER TABLE public.clients             ALTER COLUMN created_at    SET NOT NULL;
ALTER TABLE public.communes            ALTER COLUMN created_at    SET NOT NULL;
ALTER TABLE public.consumption_periods ALTER COLUMN coefficient   SET NOT NULL;
ALTER TABLE public.consumption_periods ALTER COLUMN index_estime  SET NOT NULL;
ALTER TABLE public.consumption_periods ALTER COLUMN invoice_id    SET NOT NULL;
ALTER TABLE public.contracts           ALTER COLUMN created_at    SET NOT NULL;
ALTER TABLE public.corrections_log     ALTER COLUMN corrected_at  SET NOT NULL;
ALTER TABLE public.corrections_log     ALTER COLUMN invoice_id    SET NOT NULL;
ALTER TABLE public.file_request_links  ALTER COLUMN created_at    SET NOT NULL;
ALTER TABLE public.invoice_charges     ALTER COLUMN invoice_id    SET NOT NULL;
ALTER TABLE public.invoices            ALTER COLUMN created_at    SET NOT NULL;
ALTER TABLE public.invoices            ALTER COLUMN is_duplicata  SET NOT NULL;
ALTER TABLE public.sites               ALTER COLUMN created_at    SET NOT NULL;
ALTER TABLE public.tags                ALTER COLUMN created_at    SET NOT NULL;
ALTER TABLE public.user_roles          ALTER COLUMN created_at    SET NOT NULL;

-- Sens inverse : la prod est plus stricte, et elle a raison. `travaux_estimes` pilote
-- l'affichage du rapport « avant / après » ; un NULL n'y dirait rien de plus que false.
ALTER TABLE public.communes ALTER COLUMN travaux_estimes SET DEFAULT false;
UPDATE public.communes SET travaux_estimes = false WHERE travaux_estimes IS NULL;
ALTER TABLE public.communes ALTER COLUMN travaux_estimes SET NOT NULL;

-- ============================================================
-- 3. consumption_periods : noms hérités de invoice_consumption_lines
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'invoice_consumption_lines_pkey'
      AND conrelid = 'public.consumption_periods'::regclass
  ) THEN
    ALTER TABLE public.consumption_periods
      RENAME CONSTRAINT invoice_consumption_lines_pkey TO consumption_periods_pkey;
  END IF;
END $$;

-- Doublon exact de idx_consumption_periods_invoice : deux index à maintenir sur chaque
-- écriture, pour un seul plan possible.
DROP INDEX IF EXISTS public.idx_consumption_lines_invoice;

-- ============================================================
-- 4. idx_invoices_facture_date : sens du tri
-- ============================================================

DROP INDEX IF EXISTS public.idx_invoices_facture_date;
CREATE INDEX idx_invoices_facture_date ON public.invoices USING btree (facture_date DESC);

COMMIT;
