-- ===== HISTORIQUE DES ANOMALIES : NE PLUS PERDRE LES FACTURES ENTIÈREMENT RÉSOLUES =====
--
-- La page /anomalies charge les factures via `open_anomaly_count > 0`. Conséquence :
-- résoudre la DERNIÈRE alerte d'une facture la fait sortir du chargement — et son
-- historique de résolutions disparaît de l'onglet « Historique » avec elle. L'onglet ne
-- montrait donc que les résolutions des factures ayant ENCORE une alerte ouverte.
--
-- Correctif : la vue expose aussi le compte TOTAL d'anomalies (résolues comprises) et
-- la page filtre dessus. Pas de transport de listes d'identifiants : le filtre reste
-- une colonne de la vue, comme avant.
--
-- `CREATE OR REPLACE VIEW` exige de conserver les colonnes existantes dans le même
-- ordre ; `anomaly_count` est ajoutée EN DERNIER. Le sous-select unique calcule les
-- deux comptes en un seul balayage de `anomalies` (FILTER), au lieu des deux jointures
-- qu'auraient donné deux sous-selects.
--
-- security_invoker reste actif (posé en 20260801000000) : la RLS des tables
-- sous-jacentes s'applique, la vue n'ouvre aucun accès supplémentaire.

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
  COALESCE(an.open_count, 0)  AS open_anomaly_count,
  COALESCE(an.total_count, 0) AS anomaly_count
FROM invoices i
LEFT JOIN (SELECT invoice_id, SUM(consommation_kwh) AS total_kwh
           FROM consumption_periods GROUP BY invoice_id) cp ON cp.invoice_id = i.id
LEFT JOIN (SELECT invoice_id,
                  COUNT(*) FILTER (WHERE resolved = false) AS open_count,
                  COUNT(*)                                 AS total_count
           FROM anomalies GROUP BY invoice_id) an ON an.invoice_id = i.id
LEFT JOIN sites     s   ON s.id   = i.site_id
LEFT JOIN communes  com ON com.id = i.commune_id
LEFT JOIN contracts co  ON co.id  = i.contract_id;

ALTER VIEW invoice_analytics SET (security_invoker = true);
