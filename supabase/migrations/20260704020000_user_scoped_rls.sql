-- Scope toutes les données (BD + storage) au user qui les a créées.
-- admin_smem conserve un accès total. Les communes/sites restent des données
-- de référence partagées (lecture seule pour tout authentifié).

-- ===== 1. STORAGE : scoper par dossier {user_id}/... =====
DROP POLICY IF EXISTS "authenticated_read_invoice_files"   ON storage.objects;
DROP POLICY IF EXISTS "authenticated_delete_invoice_files" ON storage.objects;

CREATE POLICY "owner_read_invoice_files" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'invoice-files'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR is_admin_smem()
    )
  );

CREATE POLICY "owner_delete_invoice_files" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'invoice-files'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR is_admin_smem()
    )
  );

-- ===== 2. COMMUNES / SITES : référence partagée (lecture tous authentifiés) =====
DROP POLICY IF EXISTS "scoped_select_communes" ON communes;
DROP POLICY IF EXISTS "scoped_select_sites"    ON sites;

CREATE POLICY "auth_read_communes" ON communes
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "auth_read_sites" ON sites
  FOR SELECT USING (auth.role() = 'authenticated');

-- ===== 3. CLIENTS : ajouter created_by + RLS user-scoped =====
ALTER TABLE clients ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id);

UPDATE clients cl
SET created_by = i.created_by
FROM invoices i
WHERE i.client_id = cl.id
  AND cl.created_by IS NULL
  AND i.created_by IS NOT NULL;

DROP POLICY IF EXISTS "scoped_clients" ON clients;
CREATE POLICY "user_scoped_clients" ON clients
  FOR ALL
  USING    (is_admin_smem() OR created_by = auth.uid())
  WITH CHECK (is_admin_smem() OR created_by = auth.uid());

-- ===== 4. CONTRACTS : ajouter created_by + RLS user-scoped =====
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id);

UPDATE contracts c
SET created_by = i.created_by
FROM invoices i
WHERE i.contract_id = c.id
  AND c.created_by IS NULL
  AND i.created_by IS NOT NULL;

DROP POLICY IF EXISTS "scoped_contracts" ON contracts;
CREATE POLICY "user_scoped_contracts" ON contracts
  FOR ALL
  USING    (is_admin_smem() OR created_by = auth.uid())
  WITH CHECK (is_admin_smem() OR created_by = auth.uid());

-- ===== 5. INVOICES : RLS user-scoped (created_by déjà présent) =====
DROP POLICY IF EXISTS "scoped_invoices" ON invoices;
CREATE POLICY "user_scoped_invoices" ON invoices
  FOR ALL
  USING    (is_admin_smem() OR created_by = auth.uid())
  WITH CHECK (is_admin_smem() OR created_by = auth.uid());

-- ===== 6. TABLES ENFANTS : scoped via invoice.created_by =====
DROP POLICY IF EXISTS "scoped_consumption_periods" ON consumption_periods;
CREATE POLICY "user_scoped_consumption_periods" ON consumption_periods
  FOR ALL
  USING (
    is_admin_smem()
    OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid())
  )
  WITH CHECK (
    is_admin_smem()
    OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid())
  );

DROP POLICY IF EXISTS "scoped_invoice_charges" ON invoice_charges;
CREATE POLICY "user_scoped_invoice_charges" ON invoice_charges
  FOR ALL
  USING (
    is_admin_smem()
    OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid())
  )
  WITH CHECK (
    is_admin_smem()
    OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid())
  );

DROP POLICY IF EXISTS "scoped_anomalies" ON anomalies;
CREATE POLICY "user_scoped_anomalies" ON anomalies
  FOR ALL
  USING (
    is_admin_smem()
    OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid())
  )
  WITH CHECK (
    is_admin_smem()
    OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid())
  );

DROP POLICY IF EXISTS "scoped_corrections_log" ON corrections_log;
CREATE POLICY "user_scoped_corrections_log" ON corrections_log
  FOR ALL
  USING (
    is_admin_smem()
    OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid())
  )
  WITH CHECK (
    is_admin_smem()
    OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid())
  );

DROP POLICY IF EXISTS "scoped_invoice_tags" ON invoice_tags;
CREATE POLICY "user_scoped_invoice_tags" ON invoice_tags
  FOR ALL
  USING (
    is_admin_smem()
    OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid())
  )
  WITH CHECK (
    is_admin_smem()
    OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid())
  );
