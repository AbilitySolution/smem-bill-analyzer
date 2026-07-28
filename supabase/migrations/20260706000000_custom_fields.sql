-- ============================================================
-- CUSTOM FIELDS — champs personnalisés réutilisables sur les
-- sections "objet simple" (localisation, en-tête facture,
-- client, contrat) de la page de vérification.
-- ============================================================

-- ===== CUSTOM FIELD DEFINITIONS =====
-- Réutilisables/partagées entre toutes les factures : une définition
-- créée une fois (section + libellé + type) devient disponible pour
-- toutes les factures suivantes.
CREATE TABLE IF NOT EXISTS custom_field_definitions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  section     text        NOT NULL CHECK (section IN ('localisation','invoice','client','contract')),
  label       text        NOT NULL,
  field_type  text        NOT NULL DEFAULT 'text' CHECK (field_type IN ('text','number','date')),
  created_by  uuid        REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Empêche deux définitions au libellé identique (insensible à la casse)
-- dans la même section — évite les quasi-doublons "Zone" / "zone".
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_field_definitions_section_label
  ON custom_field_definitions (section, lower(label));

-- ===== INVOICE CUSTOM FIELD VALUES =====
CREATE TABLE IF NOT EXISTS invoice_custom_field_values (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id    uuid        NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  definition_id uuid        NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
  value         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, definition_id)
);

-- ===== INDEXES =====
CREATE INDEX IF NOT EXISTS idx_custom_field_definitions_section    ON custom_field_definitions(section);
CREATE INDEX IF NOT EXISTS idx_invoice_custom_field_values_invoice ON invoice_custom_field_values(invoice_id);

-- ===== RLS =====
ALTER TABLE custom_field_definitions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_custom_field_values ENABLE ROW LEVEL SECURITY;

-- Définitions : partagées — lecture pour tout authentifié, création par
-- n'importe quel utilisateur authentifié, pas d'update/delete côté
-- utilisateur (admin seul peut nettoyer une définition orpheline).
CREATE POLICY "auth_read_custom_field_definitions" ON custom_field_definitions
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "auth_create_custom_field_definitions" ON custom_field_definitions
  FOR INSERT WITH CHECK (auth.role() = 'authenticated' AND created_by = auth.uid());

CREATE POLICY "admin_delete_custom_field_definitions" ON custom_field_definitions
  FOR DELETE USING (is_admin_smem());

-- Valeurs : chaîné via invoice.created_by, comme consumption_periods / invoice_charges.
CREATE POLICY "user_scoped_invoice_custom_field_values" ON invoice_custom_field_values
  FOR ALL USING (is_admin_smem() OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid()))
  WITH CHECK    (is_admin_smem() OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid()));
