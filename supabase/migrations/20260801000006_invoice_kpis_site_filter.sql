-- Le menu « regrouper par » disparaît au profit de filtres (commune, site, catégorie),
-- alignés sur ceux de /analyses. La fonction KPI reçoit donc aussi le site.
-- Signature modifiée → il faut supprimer l'ancienne surcharge, sinon les deux coexistent.
DROP FUNCTION IF EXISTS invoice_list_kpis(text, text, uuid, boolean, boolean);

CREATE OR REPLACE FUNCTION invoice_list_kpis(
  p_query           text    DEFAULT NULL,
  p_categorie       text    DEFAULT NULL,
  p_commune_id      uuid    DEFAULT NULL,
  p_site_id         uuid    DEFAULT NULL,
  p_only_anomalies  boolean DEFAULT false,
  p_show_archived   boolean DEFAULT false
)
RETURNS TABLE (
  total_count     bigint,
  sum_total_ttc   numeric,
  sum_total_kwh   numeric,
  min_annee       int,
  max_annee       int,
  archived_count  bigint,
  anomaly_count   bigint
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
      AND (p_categorie  IS NULL OR v.categorie  = p_categorie)
      AND (p_commune_id IS NULL OR v.commune_id = p_commune_id)
      AND (p_site_id    IS NULL OR v.site_id    = p_site_id)
      AND (NOT p_only_anomalies OR v.open_anomaly_count > 0)
      AND (
        p_query IS NULL OR p_query = '' OR
        COALESCE(v.facture_number, '') ILIKE '%' || p_query || '%' OR
        COALESCE(v.site_nom, '')       ILIKE '%' || p_query || '%' OR
        COALESCE(v.commune_nom, '')    ILIKE '%' || p_query || '%'
      )
  )
  SELECT
    (SELECT COUNT(*)                    FROM filtered),
    (SELECT COALESCE(SUM(total_ttc), 0) FROM filtered),
    (SELECT COALESCE(SUM(total_kwh), 0) FROM filtered),
    (SELECT MIN(annee)                  FROM filtered),
    (SELECT MAX(annee)                  FROM filtered),
    -- Compteurs des bascules : hors filtre archivé/anomalie, pour que les boutons
    -- affichent le nombre réel disponible et non le nombre déjà filtré.
    (SELECT COUNT(*) FROM scope WHERE COALESCE(archived, false) = true),
    (SELECT COUNT(*) FROM scope WHERE COALESCE(archived, false) = false AND open_anomaly_count > 0)
$$;

REVOKE EXECUTE ON FUNCTION invoice_list_kpis(text, text, uuid, uuid, boolean, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION invoice_list_kpis(text, text, uuid, uuid, boolean, boolean) TO authenticated;
