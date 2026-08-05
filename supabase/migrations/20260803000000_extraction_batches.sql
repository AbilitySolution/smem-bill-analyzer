-- ===== IMPORT DE FACTURES EN LOT (API MESSAGE BATCHES) =====
-- L'import unitaire fait un appel Claude synchrone : l'utilisateur attend devant
-- l'écran, une facture à la fois. Sur un gros volume c'est le goulot.
--
-- L'API Message Batches d'Anthropic traite N documents en une soumission, à moitié
-- prix, mais de façon ASYNCHRONE (souvent moins d'une heure, garanti sous 24 h). Il
-- faut donc persister l'état entre la soumission et la récupération : c'est l'objet
-- de ces deux tables. Sans elles, fermer l'onglet perdrait le lot.
--
--   extraction_batches      = un import déclenché par un utilisateur (1 lot Anthropic)
--   extraction_batch_items  = un document du lot, du dépôt jusqu'à la facture créée

CREATE TABLE IF NOT EXISTS extraction_batches (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid        NOT NULL REFERENCES organizations(id),
  -- NULL entre la création de la ligne et la soumission effective à Anthropic.
  anthropic_batch_id text,
  status             text        NOT NULL DEFAULT 'preparing'
                       CHECK (status IN ('preparing','submitted','importing','done','failed','canceled')),
  total_count        int         NOT NULL DEFAULT 0,
  imported_count     int         NOT NULL DEFAULT 0,
  failed_count       int         NOT NULL DEFAULT 0,
  error              text,
  created_by         uuid        REFERENCES auth.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz
);

CREATE TABLE IF NOT EXISTS extraction_batch_items (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id             uuid        NOT NULL REFERENCES extraction_batches(id) ON DELETE CASCADE,
  -- Dénormalisé depuis le lot : permet une policy RLS directe sans jointure, comme
  -- partout ailleurs dans ce schéma.
  org_id               uuid        NOT NULL REFERENCES organizations(id),
  file_path            text        NOT NULL,
  original_name        text        NOT NULL,
  status               text        NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','imported','needs_commune','skipped_duplicate','failed')),
  -- Extraction validée, conservée pour deux raisons : rejouer l'enregistrement quand
  -- l'utilisateur affecte manuellement une commune (statut needs_commune), et pouvoir
  -- diagnostiquer un échec d'import sans relancer d'appel au modèle.
  extraction           jsonb,
  suggested_commune_id uuid        REFERENCES communes(id) ON DELETE SET NULL,
  suggested_site_id    uuid        REFERENCES sites(id)    ON DELETE SET NULL,
  invoice_id           uuid        REFERENCES invoices(id) ON DELETE SET NULL,
  -- Consommation réelle remontée par le batch : le coût est mesuré, pas estimé.
  input_tokens         int,
  output_tokens        int,
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Le custom_id envoyé à Anthropic est l'id de l'item : la clé primaire garantit déjà
-- son unicité, pas de colonne dédiée.

CREATE INDEX IF NOT EXISTS idx_extraction_batches_org       ON extraction_batches(org_id);
CREATE INDEX IF NOT EXISTS idx_extraction_batch_items_org   ON extraction_batch_items(org_id);
CREATE INDEX IF NOT EXISTS idx_extraction_batch_items_batch ON extraction_batch_items(batch_id);

-- Index partiel pour le balayage du cron : il ne cherche que les lots en cours,
-- qui sont une minorité dès que l'historique grossit.
CREATE INDEX IF NOT EXISTS idx_extraction_batches_pending
  ON extraction_batches(status)
  WHERE status IN ('submitted','importing');

-- ===== RLS =====
-- Même forme que le reste du schéma : `(SELECT current_user_org_id())` et non un appel
-- nu — le wrapping permet à Postgres de mettre le résultat en cache d'initplan au lieu
-- de le réévaluer ligne par ligne (cf. 20260801000003_rls_performance.sql).

ALTER TABLE extraction_batches      ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_batch_items  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_scoped_extraction_batches" ON extraction_batches;
CREATE POLICY "org_scoped_extraction_batches" ON extraction_batches
  FOR ALL USING     (org_id = (SELECT current_user_org_id()))
          WITH CHECK (org_id = (SELECT current_user_org_id()));

DROP POLICY IF EXISTS "org_scoped_extraction_batch_items" ON extraction_batch_items;
CREATE POLICY "org_scoped_extraction_batch_items" ON extraction_batch_items
  FOR ALL USING     (org_id = (SELECT current_user_org_id()))
          WITH CHECK (org_id = (SELECT current_user_org_id()));
