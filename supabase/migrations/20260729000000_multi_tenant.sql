-- ============================================================
-- MULTI-TENANT — organisations + isolation complète entre clients
-- ============================================================
-- Passe l'app de mono-tenant (codé en dur pour SMEM) à multi-tenant :
-- chaque organisation cliente est totalement isolée des autres.
-- L'isolation passe de "par utilisateur" (created_by) à "par organisation"
-- (org_id) : tous les membres d'une même org partagent la visibilité de
-- leurs données (comportement SaaS multi-utilisateur standard).

-- ===== ORGANIZATIONS =====
CREATE TABLE IF NOT EXISTS organizations (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  nom        text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===== BACKFILL : crée l'org SMEM et y rattache toutes les données existantes =====
DO $$
DECLARE
  v_org_id uuid;
BEGIN
  INSERT INTO organizations (nom) VALUES ('SMEM') RETURNING id INTO v_org_id;

  -- Retire l'ancienne contrainte de rôle avant de renommer les valeurs.
  ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;

  -- Colonnes org_id (nullable le temps du backfill).
  ALTER TABLE communes                 ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id);
  ALTER TABLE sites                    ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id);
  ALTER TABLE clients                  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id);
  ALTER TABLE contracts                ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id);
  ALTER TABLE invoices                 ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id);
  ALTER TABLE tags                     ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id);
  ALTER TABLE custom_field_definitions ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id);
  ALTER TABLE file_request_links       ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id);
  ALTER TABLE pending_uploads          ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id);
  ALTER TABLE user_roles               ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id);

  -- Backfill : 100% des données existantes appartiennent à SMEM (seul tenant à ce jour).
  UPDATE communes                 SET org_id = v_org_id;
  UPDATE sites                    SET org_id = v_org_id;
  UPDATE clients                  SET org_id = v_org_id;
  UPDATE contracts                SET org_id = v_org_id;
  UPDATE invoices                 SET org_id = v_org_id;
  UPDATE tags                     SET org_id = v_org_id;
  UPDATE custom_field_definitions SET org_id = v_org_id;
  UPDATE file_request_links       SET org_id = v_org_id;
  UPDATE pending_uploads          SET org_id = v_org_id;
  UPDATE user_roles               SET org_id = v_org_id;

  -- Renomme les rôles (générique, plus de référence SMEM).
  UPDATE user_roles SET role = 'org_admin'  WHERE role = 'admin_smem';
  UPDATE user_roles SET role = 'org_member' WHERE role = 'agent_commune';

  -- Verrouille org_id maintenant que tout est backfillé.
  ALTER TABLE communes                 ALTER COLUMN org_id SET NOT NULL;
  ALTER TABLE sites                    ALTER COLUMN org_id SET NOT NULL;
  ALTER TABLE clients                  ALTER COLUMN org_id SET NOT NULL;
  ALTER TABLE contracts                ALTER COLUMN org_id SET NOT NULL;
  ALTER TABLE invoices                 ALTER COLUMN org_id SET NOT NULL;
  ALTER TABLE tags                     ALTER COLUMN org_id SET NOT NULL;
  ALTER TABLE custom_field_definitions ALTER COLUMN org_id SET NOT NULL;
  ALTER TABLE file_request_links       ALTER COLUMN org_id SET NOT NULL;
  ALTER TABLE pending_uploads          ALTER COLUMN org_id SET NOT NULL;
  ALTER TABLE user_roles               ALTER COLUMN org_id SET NOT NULL;

  ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check CHECK (role IN ('org_admin','org_member'));
END $$;

-- ===== user_roles : PK synthétique (1 org par utilisateur conservé via UNIQUE) =====
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_pkey;
ALTER TABLE user_roles ALTER COLUMN id SET NOT NULL;
ALTER TABLE user_roles ADD PRIMARY KEY (id);
ALTER TABLE user_roles ADD CONSTRAINT user_roles_user_id_key UNIQUE (user_id);

-- ===== INDEXES =====
CREATE INDEX IF NOT EXISTS idx_communes_org                 ON communes(org_id);
CREATE INDEX IF NOT EXISTS idx_sites_org                    ON sites(org_id);
CREATE INDEX IF NOT EXISTS idx_clients_org                  ON clients(org_id);
CREATE INDEX IF NOT EXISTS idx_contracts_org                ON contracts(org_id);
CREATE INDEX IF NOT EXISTS idx_invoices_org                 ON invoices(org_id);
CREATE INDEX IF NOT EXISTS idx_invoices_org_facture_date    ON invoices(org_id, facture_date DESC);
CREATE INDEX IF NOT EXISTS idx_tags_org                     ON tags(org_id);
CREATE INDEX IF NOT EXISTS idx_custom_field_definitions_org ON custom_field_definitions(org_id);
CREATE INDEX IF NOT EXISTS idx_file_request_links_org       ON file_request_links(org_id);
CREATE INDEX IF NOT EXISTS idx_pending_uploads_org          ON pending_uploads(org_id);

-- ===== CONTRAINTES UNIQUE : globales → composites (org_id, ...) =====
ALTER TABLE communes  DROP CONSTRAINT IF EXISTS communes_nom_key;
ALTER TABLE communes  ADD  CONSTRAINT communes_org_nom_key UNIQUE (org_id, nom);

ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_contract_number_key;
ALTER TABLE contracts ADD  CONSTRAINT contracts_org_contract_number_key UNIQUE (org_id, contract_number);

ALTER TABLE invoices  DROP CONSTRAINT IF EXISTS invoices_facture_number_key;
ALTER TABLE invoices  ADD  CONSTRAINT invoices_org_facture_number_key UNIQUE (org_id, facture_number);

ALTER TABLE tags      DROP CONSTRAINT IF EXISTS tags_label_key;
ALTER TABLE tags      ADD  CONSTRAINT tags_org_label_key UNIQUE (org_id, label);

DROP INDEX IF EXISTS uq_custom_field_definitions_section_label;
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_field_definitions_org_section_label
  ON custom_field_definitions (org_id, section, lower(label));

-- file_request_links.token reste unique global (secret aléatoire, pas une clé métier).

-- ===== HELPERS RLS =====
CREATE OR REPLACE FUNCTION current_user_org_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT org_id FROM user_roles WHERE user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION is_org_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE((SELECT role FROM user_roles WHERE user_id = auth.uid()) = 'org_admin', false)
$$;

-- ===== FUZZY COMMUNE MATCH — org-scopé (fuite cross-org sinon) =====
DROP FUNCTION IF EXISTS match_commune(text);
CREATE OR REPLACE FUNCTION match_commune(input_text text, p_org_id uuid)
RETURNS TABLE(commune_id uuid, commune_nom text, score real)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id, nom,
    similarity(lower(unaccent(nom)), lower(unaccent(input_text))) AS score
  FROM communes
  WHERE org_id = p_org_id
    AND similarity(lower(unaccent(nom)), lower(unaccent(input_text))) > 0.15
  ORDER BY score DESC
  LIMIT 1;
$$;

-- ===== RLS POLICIES — remplace is_admin_smem()/created_by par org_id =====

-- communes : lecture = membre de l'org ; écriture = org_admin (INSERT débloqué :
-- remplace le lock total de 20260704060000, une nouvelle org doit créer ses communes)
DROP POLICY IF EXISTS "auth_read_communes"    ON communes;
DROP POLICY IF EXISTS "admin_write_communes"  ON communes;
DROP POLICY IF EXISTS "admin_update_communes" ON communes;
DROP POLICY IF EXISTS "admin_delete_communes" ON communes;

CREATE POLICY "org_read_communes" ON communes
  FOR SELECT USING (org_id = current_user_org_id());
CREATE POLICY "org_admin_insert_communes" ON communes
  FOR INSERT WITH CHECK (org_id = current_user_org_id() AND is_org_admin());
CREATE POLICY "org_admin_update_communes" ON communes
  FOR UPDATE USING (org_id = current_user_org_id() AND is_org_admin())
  WITH CHECK    (org_id = current_user_org_id() AND is_org_admin());
CREATE POLICY "org_admin_delete_communes" ON communes
  FOR DELETE USING (org_id = current_user_org_id() AND is_org_admin());

-- sites
DROP POLICY IF EXISTS "auth_read_sites"   ON sites;
DROP POLICY IF EXISTS "admin_write_sites" ON sites;
CREATE POLICY "org_read_sites" ON sites FOR SELECT USING (org_id = current_user_org_id());
CREATE POLICY "org_admin_write_sites" ON sites
  FOR ALL USING (org_id = current_user_org_id() AND is_org_admin())
  WITH CHECK    (org_id = current_user_org_id() AND is_org_admin());

-- clients / contracts / invoices : accès complet à tous les membres de l'org
DROP POLICY IF EXISTS "user_scoped_clients" ON clients;
CREATE POLICY "org_scoped_clients" ON clients
  FOR ALL USING (org_id = current_user_org_id()) WITH CHECK (org_id = current_user_org_id());

DROP POLICY IF EXISTS "user_scoped_contracts" ON contracts;
CREATE POLICY "org_scoped_contracts" ON contracts
  FOR ALL USING (org_id = current_user_org_id()) WITH CHECK (org_id = current_user_org_id());

DROP POLICY IF EXISTS "user_scoped_invoices" ON invoices;
CREATE POLICY "org_scoped_invoices" ON invoices
  FOR ALL USING (org_id = current_user_org_id()) WITH CHECK (org_id = current_user_org_id());

-- Tables enfants : chaînées via invoices.org_id (pas de org_id dénormalisé)
DROP POLICY IF EXISTS "user_scoped_consumption_periods" ON consumption_periods;
CREATE POLICY "org_scoped_consumption_periods" ON consumption_periods
  FOR ALL USING     (invoice_id IN (SELECT id FROM invoices WHERE org_id = current_user_org_id()))
  WITH CHECK        (invoice_id IN (SELECT id FROM invoices WHERE org_id = current_user_org_id()));

DROP POLICY IF EXISTS "user_scoped_invoice_charges" ON invoice_charges;
CREATE POLICY "org_scoped_invoice_charges" ON invoice_charges
  FOR ALL USING     (invoice_id IN (SELECT id FROM invoices WHERE org_id = current_user_org_id()))
  WITH CHECK        (invoice_id IN (SELECT id FROM invoices WHERE org_id = current_user_org_id()));

DROP POLICY IF EXISTS "user_scoped_corrections_log" ON corrections_log;
CREATE POLICY "org_scoped_corrections_log" ON corrections_log
  FOR ALL USING     (invoice_id IN (SELECT id FROM invoices WHERE org_id = current_user_org_id()))
  WITH CHECK        (invoice_id IN (SELECT id FROM invoices WHERE org_id = current_user_org_id()));

DROP POLICY IF EXISTS "user_scoped_anomalies" ON anomalies;
CREATE POLICY "org_scoped_anomalies" ON anomalies
  FOR ALL USING     (invoice_id IN (SELECT id FROM invoices WHERE org_id = current_user_org_id()))
  WITH CHECK        (invoice_id IN (SELECT id FROM invoices WHERE org_id = current_user_org_id()));

-- tags : lecture = membre org ; écriture = org_admin
DROP POLICY IF EXISTS "authenticated_read_tags" ON tags;
DROP POLICY IF EXISTS "admin_write_tags"        ON tags;
CREATE POLICY "org_read_tags" ON tags FOR SELECT USING (org_id = current_user_org_id());
CREATE POLICY "org_admin_write_tags" ON tags
  FOR ALL USING (org_id = current_user_org_id() AND is_org_admin())
  WITH CHECK    (org_id = current_user_org_id() AND is_org_admin());

DROP POLICY IF EXISTS "user_scoped_invoice_tags" ON invoice_tags;
CREATE POLICY "org_scoped_invoice_tags" ON invoice_tags
  FOR ALL USING (invoice_id IN (SELECT id FROM invoices WHERE org_id = current_user_org_id()))
  WITH CHECK (
    invoice_id IN (SELECT id FROM invoices WHERE org_id = current_user_org_id())
    AND tag_id IN (SELECT id FROM tags WHERE org_id = current_user_org_id())
  );

-- activities : polymorphique, aucun scoping réel avant (auth.role()='authenticated' pour tout)
DROP POLICY IF EXISTS "scoped_activities" ON activities;
CREATE POLICY "org_scoped_activities" ON activities
  FOR ALL USING (
    CASE entity_type
      WHEN 'invoice'  THEN entity_id IN (SELECT id FROM invoices  WHERE org_id = current_user_org_id())
      WHEN 'contract' THEN entity_id IN (SELECT id FROM contracts WHERE org_id = current_user_org_id())
      WHEN 'site'     THEN entity_id IN (SELECT id FROM sites     WHERE org_id = current_user_org_id())
      WHEN 'commune'  THEN entity_id IN (SELECT id FROM communes  WHERE org_id = current_user_org_id())
      ELSE false
    END
  )
  WITH CHECK (
    CASE entity_type
      WHEN 'invoice'  THEN entity_id IN (SELECT id FROM invoices  WHERE org_id = current_user_org_id())
      WHEN 'contract' THEN entity_id IN (SELECT id FROM contracts WHERE org_id = current_user_org_id())
      WHEN 'site'     THEN entity_id IN (SELECT id FROM sites     WHERE org_id = current_user_org_id())
      WHEN 'commune'  THEN entity_id IN (SELECT id FROM communes  WHERE org_id = current_user_org_id())
      ELSE false
    END
  );

-- file_request_links : accès complet aux membres de l'org (restriction commune abandonnée)
DROP POLICY IF EXISTS "scoped_file_request_links" ON file_request_links;
CREATE POLICY "org_scoped_file_request_links" ON file_request_links
  FOR ALL USING (org_id = current_user_org_id()) WITH CHECK (org_id = current_user_org_id());

-- pending_uploads : était admin-only / commune-scopé ; devient accès complet aux membres de l'org
DROP POLICY IF EXISTS "admin_all_pending_uploads" ON pending_uploads;
DROP POLICY IF EXISTS "scoped_pending_uploads" ON pending_uploads;
CREATE POLICY "org_scoped_pending_uploads" ON pending_uploads
  FOR ALL USING (org_id = current_user_org_id()) WITH CHECK (org_id = current_user_org_id());

-- user_roles : self-read toujours ; org_admin lit/écrit seulement les lignes de sa propre org
DROP POLICY IF EXISTS "self_read_user_roles"   ON user_roles;
DROP POLICY IF EXISTS "admin_write_user_roles" ON user_roles;
CREATE POLICY "self_or_org_admin_read_user_roles" ON user_roles
  FOR SELECT USING (user_id = auth.uid() OR (is_org_admin() AND org_id = current_user_org_id()));
CREATE POLICY "org_admin_write_user_roles" ON user_roles
  FOR ALL USING (is_org_admin() AND org_id = current_user_org_id())
  WITH CHECK    (is_org_admin() AND org_id = current_user_org_id());

-- custom_field_definitions
DROP POLICY IF EXISTS "auth_read_custom_field_definitions"    ON custom_field_definitions;
DROP POLICY IF EXISTS "auth_create_custom_field_definitions"  ON custom_field_definitions;
DROP POLICY IF EXISTS "admin_delete_custom_field_definitions" ON custom_field_definitions;

CREATE POLICY "org_read_custom_field_definitions" ON custom_field_definitions
  FOR SELECT USING (org_id = current_user_org_id());
CREATE POLICY "org_create_custom_field_definitions" ON custom_field_definitions
  FOR INSERT WITH CHECK (org_id = current_user_org_id() AND created_by = auth.uid());
CREATE POLICY "org_admin_delete_custom_field_definitions" ON custom_field_definitions
  FOR DELETE USING (org_id = current_user_org_id() AND is_org_admin());

-- invoice_custom_field_values : chaîné via les deux parents (invoice + définition)
DROP POLICY IF EXISTS "user_scoped_invoice_custom_field_values" ON invoice_custom_field_values;
CREATE POLICY "org_scoped_invoice_custom_field_values" ON invoice_custom_field_values
  FOR ALL USING (invoice_id IN (SELECT id FROM invoices WHERE org_id = current_user_org_id()))
  WITH CHECK (
    invoice_id       IN (SELECT id FROM invoices                 WHERE org_id = current_user_org_id())
    AND definition_id IN (SELECT id FROM custom_field_definitions WHERE org_id = current_user_org_id())
  );

-- ===== STORAGE — nouveau schéma de chemin {org_id}/... =====
DROP POLICY IF EXISTS "owner_read_invoice_files"   ON storage.objects;
DROP POLICY IF EXISTS "owner_upload_invoice_files" ON storage.objects;
DROP POLICY IF EXISTS "owner_delete_invoice_files" ON storage.objects;

-- invoice-files : {org_id}/{user_id}/{filename} — lecture/suppression = tout membre
-- de l'org (aligné sur la policy invoices), upload = sous son propre user_id.
CREATE POLICY "org_read_invoice_files" ON storage.objects
  FOR SELECT USING (bucket_id = 'invoice-files' AND (storage.foldername(name))[1] = current_user_org_id()::text);
CREATE POLICY "org_delete_invoice_files" ON storage.objects
  FOR DELETE USING (bucket_id = 'invoice-files' AND (storage.foldername(name))[1] = current_user_org_id()::text);
CREATE POLICY "org_upload_invoice_files" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'invoice-files'
    AND (storage.foldername(name))[1] = current_user_org_id()::text
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

DROP POLICY IF EXISTS "admin_upload_pending_files" ON storage.objects;
DROP POLICY IF EXISTS "admin_read_pending_files"   ON storage.objects;
DROP POLICY IF EXISTS "admin_delete_pending_files" ON storage.objects;

-- pending-uploads : {org_id}/{commune_id}/{filename} — écrit uniquement par le
-- flux public /api/depot/[token] via le client service-role (contourne RLS,
-- pas besoin de policy INSERT authentifiée). Lecture/suppression = membre org.
CREATE POLICY "org_read_pending_files" ON storage.objects
  FOR SELECT USING (bucket_id = 'pending-uploads' AND (storage.foldername(name))[1] = current_user_org_id()::text);
CREATE POLICY "org_delete_pending_files" ON storage.objects
  FOR DELETE USING (bucket_id = 'pending-uploads' AND (storage.foldername(name))[1] = current_user_org_id()::text);

-- ===== NETTOYAGE — fonctions obsolètes =====
-- La restriction par commune n'est plus une frontière de sécurité (isolation
-- passe au niveau org — user_roles.commune_id devient informatif seulement).
-- Doit s'exécuter en dernier : toutes les policies qui en dépendaient ont été
-- supprimées ci-dessus. Non utilisées ailleurs (vérifié : aucun appel dans le
-- code app).
DROP FUNCTION IF EXISTS current_user_commune_id();
DROP FUNCTION IF EXISTS is_admin_smem();
DROP FUNCTION IF EXISTS current_user_role();
