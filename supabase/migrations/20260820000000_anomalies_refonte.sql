-- ============================================================
-- ANOMALIES — refonte : retrait de trois règles bruyantes
-- ============================================================
-- Contexte (portefeuille de production au 2026-08-17) : 330 anomalies ouvertes,
-- ZÉRO résolue. La page était inexploitable, donc jamais triée. Trois règles
-- concentraient 143 de ces 330 lignes sans jamais produire d'action :
--
--   hphc_same_price (95) — HP et HC au même prix unitaire. Supposait une erreur
--     d'OCR, mais beaucoup d'offres récentes et les factures à tarif unique mal
--     typées HPHC ont légitimement le même prix sur les deux postes.
--   cout_kwh_bas   (23) — coût unitaire bas. Un prix bas n'est pas une anomalie
--     de facture ; quand il trahit quelque chose, c'est une extraction partielle.
--   conso_manquante (25) — facture réelle sans kWh extrait. Décrit la qualité de
--     l'extraction, pas la facture.
--
-- Aucune des 143 lignes supprimées n'était résolue : aucun travail humain n'est
-- détruit par cette purge.
--
-- Le pic de consommation n'est pas purgé ici : lib/anomalies/persist.ts efface et
-- réécrit ce type à chaque recalcul, le nouveau calibrage (écart robuste MAD) le
-- ramènera de 162 à ~25 lignes au prochain passage.

BEGIN;

DELETE FROM anomalies
WHERE type IN ('hphc_same_price', 'cout_kwh_bas', 'conso_manquante');

-- Contrainte resserrée : les trois types ne doivent plus pouvoir revenir en base,
-- même si une version antérieure du code était redéployée par erreur.
ALTER TABLE anomalies DROP CONSTRAINT IF EXISTS anomalies_type_check;
ALTER TABLE anomalies ADD CONSTRAINT anomalies_type_check CHECK (type = ANY (ARRAY[
  -- recalculés sur tout le portefeuille (lib/anomalies/recompute.ts)
  'consumption_spike', 'cout_kwh',
  -- contrôles structurels à l'extraction (lib/anthropic/invoice-validation.ts)
  'ttc_mismatch', 'index_inversion', 'date_inversion', 'negative_amount',
  'negative_line_amount', 'tarif_type_mismatch', 'line_amount_mismatch',
  -- saisie manuelle et types historiques encore acceptés
  'validation_override', 'missing_period', 'amount_mismatch', 'tariff_change'
]::text[]));

COMMIT;
