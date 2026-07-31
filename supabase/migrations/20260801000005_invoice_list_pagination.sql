-- ===== PAGINATION SERVEUR DU HUB DOCUMENTS =====
-- Le hub chargeait toutes les factures de l'org puis filtrait/triait/agrégeait en JS.
-- On bascule filtres, tri, pagination et KPIs côté base. Deux besoins nouveaux :
--   1. filtrer « seulement les factures avec anomalie ouverte » sans charger les anomalies
--   2. calculer les KPIs sur TOUT le périmètre filtré (pas seulement la page affichée),
--      sinon « Total TTC » afficherait le total des 50 lignes visibles — trompeur.

-- 1. La vue expose le nombre d'anomalies ouvertes par facture (agrégé en SQL).
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
  co.contract_number, co.pdl, co.tarif_type, co.offre, co.puissance_souscrite_kva,
  i.org_id,
  i.facture_number,
  i.is_duplicata,
  i.file_path,
  i.archived,
  i.precision,
  COALESCE(an.open_count, 0) AS open_anomaly_count
FROM invoices i
LEFT JOIN (SELECT invoice_id, SUM(consommation_kwh) AS total_kwh
           FROM consumption_periods GROUP BY invoice_id) cp ON cp.invoice_id = i.id
LEFT JOIN (SELECT invoice_id, COUNT(*) AS open_count
           FROM anomalies WHERE resolved = false GROUP BY invoice_id) an ON an.invoice_id = i.id
LEFT JOIN sites     s   ON s.id   = i.site_id
LEFT JOIN communes  com ON com.id = i.commune_id
LEFT JOIN contracts co  ON co.id  = i.contract_id;

ALTER VIEW invoice_analytics SET (security_invoker = true);

-- 2. KPIs agrégés sur l'ensemble du périmètre filtré.
-- SECURITY INVOKER (défaut) : la RLS de invoices s'applique à l'appelant, et on filtre en
-- plus explicitement sur l'org (défense en profondeur, même logique que le reste du code).
CREATE OR REPLACE FUNCTION invoice_list_kpis(
  p_query           text    DEFAULT NULL,
  p_categorie       text    DEFAULT NULL,
  p_commune_id      uuid    DEFAULT NULL,
  p_only_anomalies  boolean DEFAULT false,
  p_show_archived   boolean DEFAULT false
)
RETURNS TABLE (
  total_count   bigint,
  sum_total_ttc numeric,
  sum_total_kwh numeric,
  min_annee     int,
  max_annee     int,
  archived_count   bigint,
  anomaly_count    bigint
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH scope AS (
    SELECT *
    FROM public.invoice_analytics v
    WHERE v.org_id = public.current_user_org_id()
  ), filtered AS (
    SELECT *
    FROM scope v
    WHERE (p_show_archived OR COALESCE(v.archived, false) = false)
      AND (p_categorie IS NULL OR v.categorie = p_categorie)
      AND (p_commune_id IS NULL OR v.commune_id = p_commune_id)
      AND (NOT p_only_anomalies OR v.open_anomaly_count > 0)
      AND (
        p_query IS NULL OR p_query = '' OR
        COALESCE(v.facture_number, '') ILIKE '%' || p_query || '%' OR
        COALESCE(v.site_nom, '')       ILIKE '%' || p_query || '%' OR
        COALESCE(v.commune_nom, '')    ILIKE '%' || p_query || '%'
      )
  )
  SELECT
    (SELECT COUNT(*)                       FROM filtered),
    (SELECT COALESCE(SUM(total_ttc), 0)    FROM filtered),
    (SELECT COALESCE(SUM(total_kwh), 0)    FROM filtered),
    (SELECT MIN(annee)                     FROM filtered),
    (SELECT MAX(annee)                     FROM filtered),
    -- Compteurs des bascules, calculés hors filtre archivé/anomalie pour que les boutons
    -- affichent le nombre réel disponible et non le nombre déjà filtré.
    (SELECT COUNT(*) FROM scope WHERE COALESCE(archived, false) = true),
    (SELECT COUNT(*) FROM scope WHERE COALESCE(archived, false) = false AND open_anomaly_count > 0)
$$;

REVOKE EXECUTE ON FUNCTION invoice_list_kpis(text, text, uuid, boolean, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION invoice_list_kpis(text, text, uuid, boolean, boolean) TO authenticated;

-- Recherche texte : ILIKE '%…%' ne peut pas utiliser un B-tree. Index trigramme sur les
-- colonnes réellement cherchées (pg_trgm est déjà activé pour le matching de communes).
CREATE INDEX IF NOT EXISTS idx_invoices_facture_number_trgm
  ON invoices USING gin (facture_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_sites_nom_trgm
  ON sites USING gin (nom gin_trgm_ops);
