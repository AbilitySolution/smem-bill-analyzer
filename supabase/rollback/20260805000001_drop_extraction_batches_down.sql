-- Rollback de 20260805000001_drop_extraction_batches.sql
--
-- Recrée les deux tables de l'import en lot par archive ZIP, à l'identique de
-- 20260803000000_extraction_batches.sql. Les lignes supprimées ne reviennent pas :
-- ce rollback rétablit la structure, pas l'historique des lots.
--
-- Le code applicatif correspondant (`/upload/batch`, `/api/batches`, `lib/batches`,
-- `/api/cron/sync-batches`) a été retiré du dépôt : il faut le restaurer depuis git
-- pour que ces tables resservent à quelque chose.

CREATE TABLE IF NOT EXISTS extraction_batches (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid        NOT NULL REFERENCES organizations(id),
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
  org_id               uuid        NOT NULL REFERENCES organizations(id),
  file_path            text        NOT NULL,
  original_name        text        NOT NULL,
  status               text        NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','imported','needs_commune','skipped_duplicate','failed')),
  extraction           jsonb,
  suggested_commune_id uuid        REFERENCES communes(id) ON DELETE SET NULL,
  suggested_site_id    uuid        REFERENCES sites(id)    ON DELETE SET NULL,
  invoice_id           uuid        REFERENCES invoices(id) ON DELETE SET NULL,
  input_tokens         int,
  output_tokens        int,
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_extraction_batches_org       ON extraction_batches(org_id);
CREATE INDEX IF NOT EXISTS idx_extraction_batch_items_org   ON extraction_batch_items(org_id);
CREATE INDEX IF NOT EXISTS idx_extraction_batch_items_batch ON extraction_batch_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_extraction_batches_pending
  ON extraction_batches(status)
  WHERE status IN ('submitted','importing');

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
