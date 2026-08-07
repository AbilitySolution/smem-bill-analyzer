-- ===== BRUIT DE LOG STUDIO : id/created_at attendus par défaut =====
--
-- Le Table Editor de Supabase Studio suppose par convention que chaque table porte
-- `id` et `created_at`, et lance une requête par défaut à l'ouverture (tri, aperçu).
-- Quatre tables ne suivaient pas cette convention et faisaient échouer cette requête
-- en 42703 (colonne inexistante) — bruit dans les logs Postgres, sans aucun rapport
-- avec l'application : aucun code du dépôt ni canal Realtime ne lit ces colonnes
-- (vérifié : `grep -rn "created_at" lib/ app/` sur ces quatre tables ne renvoie rien).
--
-- Additif uniquement. Rien n'est renommé ni supprimé :
--   - `corrections_log.corrected_at` et `anomalies.detected_at` restent la référence
--     temporelle sémantique de ces tables (immuable, posée à l'écriture) ; les
--     renommer casserait `lib/types/database.ts` et tout code qui s'appuierait dessus
--     pour rien de plus qu'un problème d'affichage Studio.
--   - `created_at` s'ajoute à côté, purement pour satisfaire la convention Studio.
--   - `invoice_tags` garde sa clé primaire composite `(invoice_id, tag_id)` — `id`
--     s'ajoute en colonne simple, sans devenir clé primaire, pour ne rien changer au
--     comportement d'écriture (`ON CONFLICT`, RLS) déjà en place.
--
-- `DEFAULT now()` / `DEFAULT gen_random_uuid()` sur ces quatre tables : fonctions non
-- constantes, Postgres doit réécrire la table pour les backfiller. Sans conséquence à
-- l'échelle de ce projet (quelques milliers de lignes au plus).

ALTER TABLE public.invoice_tags
  ADD COLUMN IF NOT EXISTS id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.invoice_charges
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.corrections_log
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.anomalies
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN public.corrections_log.created_at IS
  'Doublon cosmétique de corrected_at, pour la convention Studio. corrected_at reste la référence applicative.';
COMMENT ON COLUMN public.anomalies.created_at IS
  'Doublon cosmétique de detected_at, pour la convention Studio. detected_at reste la référence applicative.';
