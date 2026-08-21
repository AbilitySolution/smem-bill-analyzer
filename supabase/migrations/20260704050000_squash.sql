-- ============================================================
-- SQUASH — état final du schéma (remplace les 8 migrations
-- précédentes : 20260624000000 → 20260704040000)
-- ============================================================

-- ===== EXTENSIONS =====
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- ===== COMMUNES =====
CREATE TABLE IF NOT EXISTS communes (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  nom               text        NOT NULL UNIQUE,
  code_insee        text,
  points_lumineux   int,
  armoires          int,
  travaux_debut     text,
  travaux_fin       text,
  travaux_estimes   boolean,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ===== SITES =====
CREATE TABLE IF NOT EXISTS sites (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  commune_id  uuid        NOT NULL REFERENCES communes(id) ON DELETE CASCADE,
  categorie   text        NOT NULL CHECK (categorie IN ('batiment','eclairage_public')),
  nom         text        NOT NULL,
  pdl         text,
  kva         numeric,
  ampere      numeric,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ===== CLIENTS =====
CREATE TABLE IF NOT EXISTS clients (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  nom               text        NOT NULL,
  reference_client  text,
  reference_compte  text,
  adresse           text,
  commune_id        uuid        REFERENCES communes(id),
  created_by        uuid        REFERENCES auth.users(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ===== CONTRACTS =====
CREATE TABLE IF NOT EXISTS contracts (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             uuid        REFERENCES clients(id) ON DELETE CASCADE,
  site_id               uuid        REFERENCES sites(id),
  contract_number       text        NOT NULL UNIQUE,
  pdl                   text,
  tarif_type            text        CHECK (tarif_type IN ('BASE','HPHC','TEMPO','EJP')),
  espace_livraison      text,
  offre                 text,
  service               text,
  puissance_souscrite_kva numeric,
  reglage_protection_a  numeric,
  type_compteur         text,
  numero_compteur       text,
  created_by            uuid        REFERENCES auth.users(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ===== INVOICES =====
CREATE TABLE IF NOT EXISTS invoices (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id             uuid        REFERENCES contracts(id),
  client_id               uuid        REFERENCES clients(id),
  commune_id              uuid        REFERENCES communes(id),
  site_id                 uuid        REFERENCES sites(id),
  categorie               text        CHECK (categorie IN ('batiment','eclairage_public')),
  facture_number          text        NOT NULL UNIQUE,
  facture_date            date        NOT NULL,
  date_limite_paiement    date,
  date_prochain_releve    date,
  date_prochaine_facture  date,
  total_ht                numeric     NOT NULL,
  tva                     numeric,
  autres_taxes            numeric,
  total_ttc               numeric     NOT NULL,
  is_duplicata            boolean     NOT NULL DEFAULT false,
  raw_ocr_json            jsonb,
  file_path               text        NOT NULL,
  status                  text        NOT NULL DEFAULT 'pending_review'
                            CHECK (status IN ('pending_review','reviewed','anomaly_flagged')),
  archived                boolean     NOT NULL DEFAULT false,
  precision               jsonb,
  created_by              uuid        REFERENCES auth.users(id),
  created_at              timestamptz NOT NULL DEFAULT now()
);

-- ===== CONSUMPTION PERIODS =====
CREATE TABLE IF NOT EXISTS consumption_periods (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        uuid        NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  contract_id       uuid        REFERENCES contracts(id),
  poste_tarifaire   text        NOT NULL,
  period_start      date,
  period_end        date,
  numero_compteur   text,
  ancien_index      numeric,
  nouveau_index     numeric,
  coefficient       numeric     NOT NULL DEFAULT 1,
  consommation_kwh  numeric     NOT NULL,
  prix_unitaire_ckwh numeric,
  montant_eur       numeric     NOT NULL,
  index_estime      boolean     NOT NULL DEFAULT false
);

-- ===== INVOICE CHARGES (part fixe + taxes) =====
CREATE TABLE IF NOT EXISTS invoice_charges (
  id          uuid      PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid      NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  category    text      NOT NULL CHECK (category IN ('fixed','tax')),
  libelle     text      NOT NULL,
  period_start date,
  period_end   date,
  assiette    numeric,
  taux        text,
  taux_numeric numeric,
  taux_unit   text      CHECK (taux_unit IN ('eur_per_kwh','percent')),
  tarif_kva_an numeric,
  montant_eur numeric    NOT NULL
);

-- ===== CORRECTIONS LOG =====
CREATE TABLE IF NOT EXISTS corrections_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   uuid        NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  table_name   text        NOT NULL,
  row_id       uuid,
  field_name   text        NOT NULL,
  old_value    text,
  new_value    text,
  corrected_by uuid        REFERENCES auth.users(id),
  corrected_at timestamptz NOT NULL DEFAULT now()
);

-- ===== ANOMALIES =====
CREATE TABLE IF NOT EXISTS anomalies (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id            uuid        REFERENCES invoices(id) ON DELETE CASCADE,
  contract_id           uuid        REFERENCES contracts(id),
  consumption_period_id uuid        REFERENCES consumption_periods(id),
  type                  text        NOT NULL CHECK (type IN (
                          'consumption_spike','missing_period','amount_mismatch','tariff_change')),
  severity              text        NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high')),
  description           text,
  detected_value        numeric,
  expected_range_min    numeric,
  expected_range_max    numeric,
  detected_at           timestamptz NOT NULL DEFAULT now(),
  resolved              boolean     NOT NULL DEFAULT false
);

-- ===== TAGS =====
CREATE TABLE IF NOT EXISTS tags (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  label      text        NOT NULL UNIQUE,
  color      text        NOT NULL DEFAULT 'gray',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoice_tags (
  invoice_id uuid REFERENCES invoices(id) ON DELETE CASCADE,
  tag_id     uuid REFERENCES tags(id)    ON DELETE CASCADE,
  PRIMARY KEY (invoice_id, tag_id)
);

-- ===== ACTIVITIES =====
CREATE TABLE IF NOT EXISTS activities (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text        NOT NULL CHECK (entity_type IN ('invoice','contract','site','commune')),
  entity_id   uuid        NOT NULL,
  author_id   uuid        REFERENCES auth.users(id),
  body        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ===== FILE REQUEST LINKS =====
--
-- `extensions.gen_random_bytes` est qualifié à dessein. Sur un projet Supabase, pgcrypto
-- est pré-installé dans le schéma `extensions` : le `CREATE EXTENSION IF NOT EXISTS` en
-- tête de ce fichier ne fait donc rien, et la fonction reste hors de `public`.
--
-- `supabase db push` ne se connecte pas en `postgres` (dont le search_path contient
-- `extensions`) mais via un rôle `cli_login_postgres` créé pour l'occasion, sans réglage
-- de search_path — donc `"$user", public`. L'appel non qualifié y échoue :
--   ERROR: function gen_random_bytes(integer) does not exist (SQLSTATE 42883)
-- Mesuré le 2026-08-21 en rejouant ces migrations sur le projet de dev. Le stack local ne
-- le voyait pas : la CLI s'y connecte en `postgres`.
--
-- C'est la raison pour laquelle ce squash n'avait jamais pu être rejoué sur un projet
-- Supabase — et donc la raison pour laquelle la dérive avec la production a pu s'installer.
--
-- `gen_random_uuid` n'a pas le même problème : elle est native depuis PostgreSQL 13.
CREATE TABLE IF NOT EXISTS file_request_links (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  commune_id  uuid        NOT NULL REFERENCES communes(id) ON DELETE CASCADE,
  token       text        NOT NULL UNIQUE DEFAULT encode(extensions.gen_random_bytes(16),'hex'),
  label       text,
  created_by  uuid        REFERENCES auth.users(id),
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ===== PENDING UPLOADS =====
CREATE TABLE IF NOT EXISTS pending_uploads (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  commune_id            uuid        REFERENCES communes(id) ON DELETE CASCADE,
  file_request_link_id  uuid        REFERENCES file_request_links(id) ON DELETE SET NULL,
  file_path             text        NOT NULL,
  original_name         text        NOT NULL,
  status                text        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','processing','done','error')),
  processed_invoice_id  uuid        REFERENCES invoices(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ===== USER ROLES =====
CREATE TABLE IF NOT EXISTS user_roles (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('admin_smem','agent_commune')),
  commune_id uuid REFERENCES communes(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===== INDEXES =====
CREATE INDEX IF NOT EXISTS idx_sites_commune                 ON sites(commune_id);
CREATE INDEX IF NOT EXISTS idx_contracts_site               ON contracts(site_id);
CREATE INDEX IF NOT EXISTS idx_contracts_pdl                ON contracts(pdl) WHERE pdl IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_contract            ON invoices(contract_id);
CREATE INDEX IF NOT EXISTS idx_invoices_facture_date        ON invoices(facture_date DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_status              ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_commune             ON invoices(commune_id);
CREATE INDEX IF NOT EXISTS idx_invoices_site                ON invoices(site_id);
CREATE INDEX IF NOT EXISTS idx_invoices_site_date           ON invoices(site_id, facture_date DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_commune_categorie   ON invoices(commune_id, categorie);
CREATE INDEX IF NOT EXISTS idx_consumption_periods_invoice  ON consumption_periods(invoice_id);
CREATE INDEX IF NOT EXISTS idx_consumption_periods_contract ON consumption_periods(contract_id, period_start);
CREATE INDEX IF NOT EXISTS idx_invoice_charges_invoice      ON invoice_charges(invoice_id);
CREATE INDEX IF NOT EXISTS idx_anomalies_invoice            ON anomalies(invoice_id);
CREATE INDEX IF NOT EXISTS idx_anomalies_contract           ON anomalies(contract_id);
CREATE INDEX IF NOT EXISTS idx_anomalies_unresolved         ON anomalies(invoice_id, severity) WHERE resolved = false;
CREATE INDEX IF NOT EXISTS idx_activities_entity            ON activities(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_communes_nom_trgm            ON communes USING gin(nom gin_trgm_ops);

-- ===== RLS HELPER FUNCTIONS =====
CREATE OR REPLACE FUNCTION current_user_role()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT role FROM user_roles WHERE user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION current_user_commune_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT commune_id FROM user_roles WHERE user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION is_admin_smem()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE((SELECT role FROM user_roles WHERE user_id = auth.uid()) = 'admin_smem', false)
$$;

-- ===== FUZZY COMMUNE MATCH =====
CREATE OR REPLACE FUNCTION match_commune(input_text text)
RETURNS TABLE(commune_id uuid, commune_nom text, score real) AS $$
  SELECT id, nom,
    similarity(lower(unaccent(nom)), lower(unaccent(input_text))) AS score
  FROM communes
  WHERE similarity(lower(unaccent(nom)), lower(unaccent(input_text))) > 0.15
  ORDER BY score DESC
  LIMIT 1;
$$ LANGUAGE sql STABLE;

-- ===== ANALYTICS VIEW =====
CREATE OR REPLACE VIEW invoice_analytics AS
SELECT
  i.id, i.site_id, i.commune_id, i.categorie,
  i.facture_date,
  EXTRACT(YEAR  FROM i.facture_date)::int AS annee,
  EXTRACT(MONTH FROM i.facture_date)::int AS mois,
  i.total_ht, i.total_ttc, i.tva, i.autres_taxes, i.status,
  COALESCE(cp.total_kwh, 0) AS total_kwh,
  CASE WHEN COALESCE(cp.total_kwh, 0) > 0
    THEN ROUND((i.total_ttc / cp.total_kwh)::numeric, 4) END        AS cout_par_kwh_eur,
  CASE WHEN COALESCE(cp.total_kwh, 0) > 0
    THEN ROUND((i.total_ttc / cp.total_kwh * 100)::numeric, 4) END  AS cout_par_kwh_cents,
  s.nom   AS site_nom,
  com.nom AS commune_nom,
  co.contract_number, co.pdl, co.tarif_type, co.offre, co.puissance_souscrite_kva
FROM invoices i
LEFT JOIN (SELECT invoice_id, SUM(consommation_kwh) AS total_kwh
           FROM consumption_periods GROUP BY invoice_id) cp ON cp.invoice_id = i.id
LEFT JOIN sites     s   ON s.id   = i.site_id
LEFT JOIN communes  com ON com.id = i.commune_id
LEFT JOIN contracts co  ON co.id  = i.contract_id;

-- ===== ENABLE RLS =====
ALTER TABLE communes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites            ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients          ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices         ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumption_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_charges  ENABLE ROW LEVEL SECURITY;
ALTER TABLE corrections_log  ENABLE ROW LEVEL SECURITY;
ALTER TABLE anomalies        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags             ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_tags     ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities       ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_request_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_uploads  ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles       ENABLE ROW LEVEL SECURITY;

-- ===== RLS POLICIES =====

-- Communes : lecture pour tous les authentifiés, écriture admin seul
CREATE POLICY "auth_read_communes"   ON communes FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "admin_write_communes" ON communes FOR ALL    USING (is_admin_smem()) WITH CHECK (is_admin_smem());

-- Sites : lecture pour tous les authentifiés, écriture admin seul
CREATE POLICY "auth_read_sites"   ON sites FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "admin_write_sites" ON sites FOR ALL    USING (is_admin_smem()) WITH CHECK (is_admin_smem());

-- Clients : scopé au créateur
CREATE POLICY "user_scoped_clients" ON clients
  FOR ALL USING (is_admin_smem() OR created_by = auth.uid())
  WITH CHECK    (is_admin_smem() OR created_by = auth.uid());

-- Contracts : scopé au créateur
CREATE POLICY "user_scoped_contracts" ON contracts
  FOR ALL USING (is_admin_smem() OR created_by = auth.uid())
  WITH CHECK    (is_admin_smem() OR created_by = auth.uid());

-- Invoices : scopé au créateur
CREATE POLICY "user_scoped_invoices" ON invoices
  FOR ALL USING (is_admin_smem() OR created_by = auth.uid())
  WITH CHECK    (is_admin_smem() OR created_by = auth.uid());

-- Consumption periods : chaîné via invoice.created_by
CREATE POLICY "user_scoped_consumption_periods" ON consumption_periods
  FOR ALL USING (is_admin_smem() OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid()))
  WITH CHECK    (is_admin_smem() OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid()));

-- Invoice charges : chaîné via invoice.created_by
CREATE POLICY "user_scoped_invoice_charges" ON invoice_charges
  FOR ALL USING (is_admin_smem() OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid()))
  WITH CHECK    (is_admin_smem() OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid()));

-- Corrections log : chaîné via invoice.created_by
CREATE POLICY "user_scoped_corrections_log" ON corrections_log
  FOR ALL USING (is_admin_smem() OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid()))
  WITH CHECK    (is_admin_smem() OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid()));

-- Anomalies : chaîné via invoice.created_by
CREATE POLICY "user_scoped_anomalies" ON anomalies
  FOR ALL USING (is_admin_smem() OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid()))
  WITH CHECK    (is_admin_smem() OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid()));

-- Tags : lecture pour tous, écriture admin
CREATE POLICY "authenticated_read_tags" ON tags FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "admin_write_tags"        ON tags FOR ALL    USING (is_admin_smem()) WITH CHECK (is_admin_smem());

-- Invoice tags : chaîné via invoice.created_by
CREATE POLICY "user_scoped_invoice_tags" ON invoice_tags
  FOR ALL USING (is_admin_smem() OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid()))
  WITH CHECK    (is_admin_smem() OR invoice_id IN (SELECT id FROM invoices WHERE created_by = auth.uid()));

-- Activities : tout authentifié
CREATE POLICY "scoped_activities" ON activities
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

-- File request links : admin ou commune de l'agent
CREATE POLICY "scoped_file_request_links" ON file_request_links
  FOR ALL USING    (is_admin_smem() OR commune_id = current_user_commune_id())
  WITH CHECK       (is_admin_smem() OR commune_id = current_user_commune_id());

-- Pending uploads : admin seul
CREATE POLICY "admin_all_pending_uploads" ON pending_uploads
  FOR ALL USING (is_admin_smem());

-- User roles : lecture soi-même ou admin ; écriture admin seul
CREATE POLICY "self_read_user_roles"  ON user_roles FOR SELECT USING (user_id = auth.uid() OR is_admin_smem());
CREATE POLICY "admin_write_user_roles" ON user_roles FOR ALL    USING (is_admin_smem()) WITH CHECK (is_admin_smem());

-- ===== STORAGE BUCKETS =====
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('invoice-files', 'invoice-files', false, 20971520,
        ARRAY['application/pdf','image/jpeg','image/png','image/tiff'])
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('pending-uploads', 'pending-uploads', false, 20971520,
        ARRAY['application/pdf','image/jpeg','image/png','image/tiff'])
ON CONFLICT (id) DO NOTHING;

-- Storage policies — invoice-files
CREATE POLICY "owner_read_invoice_files" ON storage.objects
  FOR SELECT USING (bucket_id = 'invoice-files'
    AND ((storage.foldername(name))[1] = auth.uid()::text OR is_admin_smem()));

CREATE POLICY "owner_upload_invoice_files" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'invoice-files'
    AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "owner_delete_invoice_files" ON storage.objects
  FOR DELETE USING (bucket_id = 'invoice-files'
    AND ((storage.foldername(name))[1] = auth.uid()::text OR is_admin_smem()));

-- Storage policies — pending-uploads (admin only)
CREATE POLICY "admin_upload_pending_files" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'pending-uploads' AND is_admin_smem());

CREATE POLICY "admin_read_pending_files" ON storage.objects
  FOR SELECT USING (bucket_id = 'pending-uploads' AND is_admin_smem());

CREATE POLICY "admin_delete_pending_files" ON storage.objects
  FOR DELETE USING (bucket_id = 'pending-uploads' AND is_admin_smem());

-- ===== SEED DATA =====
INSERT INTO tags (label, color) VALUES
  ('À vérifier', 'amber'),
  ('Validée',    'green'),
  ('Anomalie',   'red'),
  ('Duplicata',  'gray')
ON CONFLICT (label) DO NOTHING;

INSERT INTO communes (nom) VALUES
  ('Bellefontaine'), ('Carbet'), ('Case Pilote'), ('Ducos'),
  ('Fonds Saint Denis'), ('Grand Rivière'), ('Gros Morne'), ('La Trinité'),
  ('Le Marigot'), ('Le Morne Rouge'), ('Le Morne Vert'), ('Le Prêcheur'),
  ('Le Robert'), ('Le Vauclin'), ('Les Anses d''Arlet'), ('Les Trois Ilets'),
  ('Macouba'), ('Saint Esprit'), ('Sainte Anne'), ('Sainte Marie')
ON CONFLICT (nom) DO NOTHING;
