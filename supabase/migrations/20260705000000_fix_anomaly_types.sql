-- Fix anomaly type constraint: expand to include all codes written by application code.
-- Previously only ('consumption_spike','missing_period','amount_mismatch','tariff_change')
-- were allowed, causing all IDP-validation anomalies to fail silently on insert.
ALTER TABLE anomalies DROP CONSTRAINT IF EXISTS anomalies_type_check;
ALTER TABLE anomalies ADD CONSTRAINT anomalies_type_check CHECK (
  type IN (
    'consumption_spike',
    'missing_period',
    'amount_mismatch',
    'tariff_change',
    'ttc_mismatch',
    'index_inversion',
    'date_inversion',
    'hphc_same_price',
    'validation_override',
    'line_amount_mismatch',
    'negative_amount',
    'negative_line_amount',
    'tarif_type_mismatch'
  )
);
