-- L-4: invoice_analytics view was computing cout_par_kwh from total_ht.
-- App code (costPerKwh) uses total_ttc — align view to match.
CREATE OR REPLACE VIEW invoice_analytics AS
SELECT
  i.id,
  i.site_id,
  i.commune_id,
  i.categorie,
  i.facture_date,
  EXTRACT(YEAR  FROM i.facture_date)::int AS annee,
  EXTRACT(MONTH FROM i.facture_date)::int AS mois,
  i.total_ht,
  i.total_ttc,
  i.tva,
  i.autres_taxes,
  i.status,
  COALESCE(cp.total_kwh, 0)                                                     AS total_kwh,
  CASE WHEN COALESCE(cp.total_kwh, 0) > 0
    THEN ROUND((i.total_ttc / cp.total_kwh)::numeric, 4)
    ELSE NULL
  END                                                                            AS cout_par_kwh_eur,
  CASE WHEN COALESCE(cp.total_kwh, 0) > 0
    THEN ROUND((i.total_ttc / cp.total_kwh * 100)::numeric, 4)
    ELSE NULL
  END                                                                            AS cout_par_kwh_cents,
  s.nom                                                                          AS site_nom,
  com.nom                                                                        AS commune_nom,
  co.contract_number,
  co.pdl,
  co.tarif_type,
  co.offre,
  co.puissance_souscrite_kva
FROM invoices i
LEFT JOIN (
  SELECT invoice_id, SUM(consommation_kwh) AS total_kwh
  FROM consumption_periods
  GROUP BY invoice_id
) cp ON cp.invoice_id = i.id
LEFT JOIN sites     s   ON s.id   = i.site_id
LEFT JOIN communes  com ON com.id = i.commune_id
LEFT JOIN contracts co  ON co.id  = i.contract_id;
