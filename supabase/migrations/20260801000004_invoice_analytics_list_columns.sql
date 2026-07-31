-- getInvoiceDocs() rapatriait TOUTES les lignes de consumption_periods de l'org à chaque
-- affichage de /documents et /anomalies, uniquement pour en tirer une somme de kWh par
-- facture (le détail des lignes n'était consommé par aucun composant vivant).
-- Coût : ~1 requête + N lignes enfants par visite, là où la vue invoice_analytics agrège
-- déjà total_kwh en SQL. On complète la vue avec les colonnes que la liste utilise, pour
-- que la page tienne en UNE requête au lieu de deux.
--
-- security_invoker reste actif (posé en 20260801000000) : la RLS des tables sous-jacentes
-- s'applique, la vue n'ouvre aucun accès supplémentaire.
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
  -- Colonnes ajoutées pour le hub documents (liste + export CSV + vignettes).
  i.org_id,
  i.facture_number,
  i.is_duplicata,
  i.file_path,
  i.archived,
  i.precision
FROM invoices i
LEFT JOIN (SELECT invoice_id, SUM(consommation_kwh) AS total_kwh
           FROM consumption_periods GROUP BY invoice_id) cp ON cp.invoice_id = i.id
LEFT JOIN sites     s   ON s.id   = i.site_id
LEFT JOIN communes  com ON com.id = i.commune_id
LEFT JOIN contracts co  ON co.id  = i.contract_id;

ALTER VIEW invoice_analytics SET (security_invoker = true);
