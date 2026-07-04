-- Performance indexes for common analytics queries
CREATE INDEX IF NOT EXISTS idx_invoices_site_date
  ON invoices(site_id, facture_date DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_commune_categorie
  ON invoices(commune_id, categorie);

CREATE INDEX IF NOT EXISTS idx_consumption_periods_invoice
  ON consumption_periods(invoice_id);

CREATE INDEX IF NOT EXISTS idx_invoice_charges_invoice
  ON invoice_charges(invoice_id);

CREATE INDEX IF NOT EXISTS idx_anomalies_invoice
  ON anomalies(invoice_id);

-- Partial index for unresolved anomalies (dashboard hotpath)
CREATE INDEX IF NOT EXISTS idx_anomalies_unresolved
  ON anomalies(invoice_id, severity)
  WHERE resolved = false;

-- PDL and tarif_type on contracts
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS pdl text,
  ADD COLUMN IF NOT EXISTS tarif_type text CHECK (tarif_type IN ('BASE', 'HPHC', 'TEMPO', 'EJP'));

CREATE INDEX IF NOT EXISTS idx_contracts_pdl
  ON contracts(pdl)
  WHERE pdl IS NOT NULL;

-- Backfill pdl from sites where contract is linked to a site with pdl
UPDATE contracts c
SET pdl = s.pdl
FROM sites s
WHERE c.site_id = s.id
  AND s.pdl IS NOT NULL
  AND c.pdl IS NULL;

-- Analytics view: invoice-level with pre-computed cost/kWh and joins
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
    THEN ROUND((i.total_ht / cp.total_kwh)::numeric, 4)
    ELSE NULL
  END                                                                            AS cout_par_kwh_eur,
  CASE WHEN COALESCE(cp.total_kwh, 0) > 0
    THEN ROUND((i.total_ht / cp.total_kwh * 100)::numeric, 4)
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
