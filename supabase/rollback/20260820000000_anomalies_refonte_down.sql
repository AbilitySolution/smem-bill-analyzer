-- Rollback de 20260820000000_anomalies_refonte.sql
--
-- ATTENTION : ce rollback restaure la CONTRAINTE, pas les données. Les 143 lignes
-- supprimées (hphc_same_price, cout_kwh_bas, conso_manquante) ne sont pas
-- récupérables par ce script — elles seront régénérées au prochain recalcul si, et
-- seulement si, le code applicatif correspondant est lui aussi restauré :
--   lib/anthropic/invoice-validation.ts  → règle HPHC_SAME_PRICE
--   lib/anomalies/recompute.ts           → règles cout_kwh_bas et conso_manquante
-- Ces règles n'étant émises qu'à l'extraction pour la première, les factures déjà
-- enregistrées ne retrouveront pas leurs anomalies hphc_same_price sans réimport.

BEGIN;

ALTER TABLE anomalies DROP CONSTRAINT IF EXISTS anomalies_type_check;
ALTER TABLE anomalies ADD CONSTRAINT anomalies_type_check CHECK (type = ANY (ARRAY[
  'consumption_spike', 'missing_period', 'amount_mismatch', 'tariff_change',
  'ttc_mismatch', 'index_inversion', 'date_inversion', 'hphc_same_price',
  'validation_override', 'line_amount_mismatch', 'negative_amount',
  'negative_line_amount', 'tarif_type_mismatch',
  'cout_kwh', 'cout_kwh_bas', 'conso_manquante'
]::text[]));

COMMIT;
