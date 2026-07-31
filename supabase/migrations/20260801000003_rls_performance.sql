-- ===== PERFORMANCE RLS =====
-- Les policies issues de la migration multi-tenant appellent current_user_org_id() /
-- is_org_admin() / auth.uid() SANS les envelopper dans un SELECT. Postgres les traite
-- alors comme des expressions volatiles évaluées LIGNE PAR LIGNE : sur 10 000 factures,
-- current_user_org_id() (qui fait elle-même un SELECT sur user_roles) est appelée
-- 10 000 fois pour une seule requête.
--
-- Envelopper l'appel dans (SELECT ...) le transforme en InitPlan : Postgres l'évalue
-- UNE fois et réutilise le résultat. Recommandation officielle Supabase, 5-10x sur les
-- grandes tables. Aucune sémantique ne change — mêmes règles d'accès exactement.
--
-- Voir : https://supabase.com/docs/guides/database/postgres/row-level-security#rls-performance-recommendations

-- ===== communes =====
DROP POLICY IF EXISTS "org_read_communes"          ON communes;
DROP POLICY IF EXISTS "org_admin_insert_communes"  ON communes;
DROP POLICY IF EXISTS "org_admin_update_communes"  ON communes;
DROP POLICY IF EXISTS "org_admin_delete_communes"  ON communes;

CREATE POLICY "org_read_communes" ON communes
  FOR SELECT USING (org_id = (SELECT current_user_org_id()));
CREATE POLICY "org_admin_insert_communes" ON communes
  FOR INSERT WITH CHECK (org_id = (SELECT current_user_org_id()) AND (SELECT is_org_admin()));
CREATE POLICY "org_admin_update_communes" ON communes
  FOR UPDATE USING (org_id = (SELECT current_user_org_id()) AND (SELECT is_org_admin()))
  WITH CHECK    (org_id = (SELECT current_user_org_id()) AND (SELECT is_org_admin()));
CREATE POLICY "org_admin_delete_communes" ON communes
  FOR DELETE USING (org_id = (SELECT current_user_org_id()) AND (SELECT is_org_admin()));

-- ===== sites =====
DROP POLICY IF EXISTS "org_read_sites"       ON sites;
DROP POLICY IF EXISTS "org_admin_write_sites" ON sites;
CREATE POLICY "org_read_sites" ON sites
  FOR SELECT USING (org_id = (SELECT current_user_org_id()));
CREATE POLICY "org_admin_write_sites" ON sites
  FOR ALL USING (org_id = (SELECT current_user_org_id()) AND (SELECT is_org_admin()))
  WITH CHECK    (org_id = (SELECT current_user_org_id()) AND (SELECT is_org_admin()));

-- ===== clients / contracts / invoices =====
DROP POLICY IF EXISTS "org_scoped_clients" ON clients;
CREATE POLICY "org_scoped_clients" ON clients
  FOR ALL USING (org_id = (SELECT current_user_org_id()))
  WITH CHECK    (org_id = (SELECT current_user_org_id()));

DROP POLICY IF EXISTS "org_scoped_contracts" ON contracts;
CREATE POLICY "org_scoped_contracts" ON contracts
  FOR ALL USING (org_id = (SELECT current_user_org_id()))
  WITH CHECK    (org_id = (SELECT current_user_org_id()));

DROP POLICY IF EXISTS "org_scoped_invoices" ON invoices;
CREATE POLICY "org_scoped_invoices" ON invoices
  FOR ALL USING (org_id = (SELECT current_user_org_id()))
  WITH CHECK    (org_id = (SELECT current_user_org_id()));

-- ===== tables enfants (chaînées via invoices.org_id) =====
DROP POLICY IF EXISTS "org_scoped_consumption_periods" ON consumption_periods;
CREATE POLICY "org_scoped_consumption_periods" ON consumption_periods
  FOR ALL USING     (invoice_id IN (SELECT id FROM invoices WHERE org_id = (SELECT current_user_org_id())))
  WITH CHECK        (invoice_id IN (SELECT id FROM invoices WHERE org_id = (SELECT current_user_org_id())));

DROP POLICY IF EXISTS "org_scoped_invoice_charges" ON invoice_charges;
CREATE POLICY "org_scoped_invoice_charges" ON invoice_charges
  FOR ALL USING     (invoice_id IN (SELECT id FROM invoices WHERE org_id = (SELECT current_user_org_id())))
  WITH CHECK        (invoice_id IN (SELECT id FROM invoices WHERE org_id = (SELECT current_user_org_id())));

DROP POLICY IF EXISTS "org_scoped_corrections_log" ON corrections_log;
CREATE POLICY "org_scoped_corrections_log" ON corrections_log
  FOR ALL USING     (invoice_id IN (SELECT id FROM invoices WHERE org_id = (SELECT current_user_org_id())))
  WITH CHECK        (invoice_id IN (SELECT id FROM invoices WHERE org_id = (SELECT current_user_org_id())));

DROP POLICY IF EXISTS "org_scoped_anomalies" ON anomalies;
CREATE POLICY "org_scoped_anomalies" ON anomalies
  FOR ALL USING     (invoice_id IN (SELECT id FROM invoices WHERE org_id = (SELECT current_user_org_id())))
  WITH CHECK        (invoice_id IN (SELECT id FROM invoices WHERE org_id = (SELECT current_user_org_id())));

-- ===== tags =====
DROP POLICY IF EXISTS "org_read_tags"        ON tags;
DROP POLICY IF EXISTS "org_admin_write_tags" ON tags;
CREATE POLICY "org_read_tags" ON tags
  FOR SELECT USING (org_id = (SELECT current_user_org_id()));
CREATE POLICY "org_admin_write_tags" ON tags
  FOR ALL USING (org_id = (SELECT current_user_org_id()) AND (SELECT is_org_admin()))
  WITH CHECK    (org_id = (SELECT current_user_org_id()) AND (SELECT is_org_admin()));

DROP POLICY IF EXISTS "org_scoped_invoice_tags" ON invoice_tags;
CREATE POLICY "org_scoped_invoice_tags" ON invoice_tags
  FOR ALL USING (invoice_id IN (SELECT id FROM invoices WHERE org_id = (SELECT current_user_org_id())))
  WITH CHECK (
    invoice_id    IN (SELECT id FROM invoices WHERE org_id = (SELECT current_user_org_id()))
    AND tag_id    IN (SELECT id FROM tags     WHERE org_id = (SELECT current_user_org_id()))
  );

-- ===== activities (polymorphe) =====
DROP POLICY IF EXISTS "org_scoped_activities" ON activities;
CREATE POLICY "org_scoped_activities" ON activities
  FOR ALL USING (
    CASE entity_type
      WHEN 'invoice'  THEN entity_id IN (SELECT id FROM invoices  WHERE org_id = (SELECT current_user_org_id()))
      WHEN 'contract' THEN entity_id IN (SELECT id FROM contracts WHERE org_id = (SELECT current_user_org_id()))
      WHEN 'site'     THEN entity_id IN (SELECT id FROM sites     WHERE org_id = (SELECT current_user_org_id()))
      WHEN 'commune'  THEN entity_id IN (SELECT id FROM communes  WHERE org_id = (SELECT current_user_org_id()))
      ELSE false
    END
  )
  WITH CHECK (
    CASE entity_type
      WHEN 'invoice'  THEN entity_id IN (SELECT id FROM invoices  WHERE org_id = (SELECT current_user_org_id()))
      WHEN 'contract' THEN entity_id IN (SELECT id FROM contracts WHERE org_id = (SELECT current_user_org_id()))
      WHEN 'site'     THEN entity_id IN (SELECT id FROM sites     WHERE org_id = (SELECT current_user_org_id()))
      WHEN 'commune'  THEN entity_id IN (SELECT id FROM communes  WHERE org_id = (SELECT current_user_org_id()))
      ELSE false
    END
  );

-- ===== file_request_links / pending_uploads =====
DROP POLICY IF EXISTS "org_scoped_file_request_links" ON file_request_links;
CREATE POLICY "org_scoped_file_request_links" ON file_request_links
  FOR ALL USING (org_id = (SELECT current_user_org_id()))
  WITH CHECK    (org_id = (SELECT current_user_org_id()));

DROP POLICY IF EXISTS "org_scoped_pending_uploads" ON pending_uploads;
CREATE POLICY "org_scoped_pending_uploads" ON pending_uploads
  FOR ALL USING (org_id = (SELECT current_user_org_id()))
  WITH CHECK    (org_id = (SELECT current_user_org_id()));

-- ===== user_roles =====
DROP POLICY IF EXISTS "self_or_org_admin_read_user_roles" ON user_roles;
DROP POLICY IF EXISTS "org_admin_write_user_roles"        ON user_roles;
CREATE POLICY "self_or_org_admin_read_user_roles" ON user_roles
  FOR SELECT USING (
    user_id = (SELECT auth.uid())
    OR ((SELECT is_org_admin()) AND org_id = (SELECT current_user_org_id()))
  );
CREATE POLICY "org_admin_write_user_roles" ON user_roles
  FOR ALL USING ((SELECT is_org_admin()) AND org_id = (SELECT current_user_org_id()))
  WITH CHECK    ((SELECT is_org_admin()) AND org_id = (SELECT current_user_org_id()));

-- ===== custom_field_definitions / values =====
DROP POLICY IF EXISTS "org_read_custom_field_definitions"         ON custom_field_definitions;
DROP POLICY IF EXISTS "org_create_custom_field_definitions"       ON custom_field_definitions;
DROP POLICY IF EXISTS "org_admin_delete_custom_field_definitions" ON custom_field_definitions;

CREATE POLICY "org_read_custom_field_definitions" ON custom_field_definitions
  FOR SELECT USING (org_id = (SELECT current_user_org_id()));
CREATE POLICY "org_create_custom_field_definitions" ON custom_field_definitions
  FOR INSERT WITH CHECK (org_id = (SELECT current_user_org_id()) AND created_by = (SELECT auth.uid()));
CREATE POLICY "org_admin_delete_custom_field_definitions" ON custom_field_definitions
  FOR DELETE USING (org_id = (SELECT current_user_org_id()) AND (SELECT is_org_admin()));

DROP POLICY IF EXISTS "org_scoped_invoice_custom_field_values" ON invoice_custom_field_values;
CREATE POLICY "org_scoped_invoice_custom_field_values" ON invoice_custom_field_values
  FOR ALL USING (invoice_id IN (SELECT id FROM invoices WHERE org_id = (SELECT current_user_org_id())))
  WITH CHECK (
    invoice_id        IN (SELECT id FROM invoices                 WHERE org_id = (SELECT current_user_org_id()))
    AND definition_id IN (SELECT id FROM custom_field_definitions WHERE org_id = (SELECT current_user_org_id()))
  );

-- ===== organizations (ajouté en 20260801000001) =====
DROP POLICY IF EXISTS "org_read_organizations"         ON organizations;
DROP POLICY IF EXISTS "org_admin_update_organizations" ON organizations;
CREATE POLICY "org_read_organizations" ON organizations
  FOR SELECT USING (id = (SELECT current_user_org_id()));
CREATE POLICY "org_admin_update_organizations" ON organizations
  FOR UPDATE USING (id = (SELECT current_user_org_id()) AND (SELECT is_org_admin()))
  WITH CHECK    (id = (SELECT current_user_org_id()) AND (SELECT is_org_admin()));

-- ===== storage =====
DROP POLICY IF EXISTS "org_read_invoice_files"   ON storage.objects;
DROP POLICY IF EXISTS "org_delete_invoice_files" ON storage.objects;
DROP POLICY IF EXISTS "org_upload_invoice_files" ON storage.objects;

CREATE POLICY "org_read_invoice_files" ON storage.objects
  FOR SELECT USING (bucket_id = 'invoice-files' AND (storage.foldername(name))[1] = (SELECT current_user_org_id())::text);
CREATE POLICY "org_delete_invoice_files" ON storage.objects
  FOR DELETE USING (bucket_id = 'invoice-files' AND (storage.foldername(name))[1] = (SELECT current_user_org_id())::text);
CREATE POLICY "org_upload_invoice_files" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'invoice-files'
    AND (storage.foldername(name))[1] = (SELECT current_user_org_id())::text
    AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
  );

DROP POLICY IF EXISTS "org_read_pending_files"   ON storage.objects;
DROP POLICY IF EXISTS "org_delete_pending_files" ON storage.objects;
CREATE POLICY "org_read_pending_files" ON storage.objects
  FOR SELECT USING (bucket_id = 'pending-uploads' AND (storage.foldername(name))[1] = (SELECT current_user_org_id())::text);
CREATE POLICY "org_delete_pending_files" ON storage.objects
  FOR DELETE USING (bucket_id = 'pending-uploads' AND (storage.foldername(name))[1] = (SELECT current_user_org_id())::text);

-- ===== INDEX MANQUANT =====
-- corrections_log.invoice_id est une clé étrangère non indexée : Postgres n'indexe pas
-- les FK automatiquement. Elle est pourtant filtrée par la policy RLS ci-dessus ET par
-- les métriques de qualité d'extraction → sans index, seq scan complet à chaque lecture.
CREATE INDEX IF NOT EXISTS idx_corrections_log_invoice ON corrections_log (invoice_id);
