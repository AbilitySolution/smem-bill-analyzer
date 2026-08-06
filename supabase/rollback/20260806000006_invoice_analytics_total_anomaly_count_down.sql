-- Rollback de 20260806000006_invoice_analytics_total_anomaly_count.sql
--
-- ⚠️ Redéployer d'abord l'application dans sa version précédente : `getInvoiceDocs`
-- filtre sur `anomaly_count`, colonne que ce rollback supprime.
--
-- ⚠️ Effet : l'onglet « Historique » de /anomalies reperd les factures dont toutes les
-- anomalies sont résolues.
--
-- `CREATE OR REPLACE VIEW` ne sait pas retirer une colonne : DROP puis recréation à
-- l'identique de 20260801000005.

DROP VIEW IF EXISTS invoice_analytics;

CREATE VIEW invoice_analytics AS
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
