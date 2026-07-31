-- ============================================================
-- ANOMALIES — nouveaux types "portefeuille" (lib/anomalies/recompute.ts)
-- ============================================================
-- cout_kwh / cout_kwh_bas : coût unitaire vs médiane (année, catégorie)
-- conso_manquante         : facture réelle sans consommation extraite

ALTER TABLE anomalies DROP CONSTRAINT IF EXISTS anomalies_type_check;
ALTER TABLE anomalies ADD CONSTRAINT anomalies_type_check CHECK (type = ANY (ARRAY[
  'consumption_spike', 'missing_period', 'amount_mismatch', 'tariff_change',
  'ttc_mismatch', 'index_inversion', 'date_inversion', 'hphc_same_price',
  'validation_override', 'line_amount_mismatch', 'negative_amount',
  'negative_line_amount', 'tarif_type_mismatch',
  'cout_kwh', 'cout_kwh_bas', 'conso_manquante'
]::text[]));
