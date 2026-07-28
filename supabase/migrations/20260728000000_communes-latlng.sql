-- ============================================================
-- COMMUNES — coordonnées géographiques (latitude/longitude)
-- Nécessaire pour le module de prévision de consommation :
--   - éclairage public → longueur de nuit (calcul astronomique, latitude seule)
--   - bâtiments        → température (API météo Open-Meteo, latitude + longitude)
-- ============================================================

-- ===== COLONNES =====
ALTER TABLE communes ADD COLUMN IF NOT EXISTS latitude  numeric;
ALTER TABLE communes ADD COLUMN IF NOT EXISTS longitude numeric;

-- ===== SEED — coordonnées approximatives du centroïde de chaque commune =====
-- (données géographiques publiques, non sensibles — précision suffisante
--  pour une correction météo/nuit à l'échelle mensuelle)
UPDATE communes SET latitude = 14.6667, longitude = -61.1667 WHERE nom = 'Bellefontaine';
UPDATE communes SET latitude = 14.7167, longitude = -61.1667 WHERE nom = 'Carbet';
UPDATE communes SET latitude = 14.6167, longitude = -61.2167 WHERE nom = 'Case Pilote';
UPDATE communes SET latitude = 14.6833, longitude = -60.9833 WHERE nom = 'Ducos';
UPDATE communes SET latitude = 14.7333, longitude = -61.1167 WHERE nom = 'Fonds Saint Denis';
UPDATE communes SET latitude = 14.8667, longitude = -61.2167 WHERE nom = 'Grand Rivière';
UPDATE communes SET latitude = 14.7667, longitude = -61.0167 WHERE nom = 'Gros Morne';
UPDATE communes SET latitude = 14.7333, longitude = -60.9667 WHERE nom = 'La Trinité';
UPDATE communes SET latitude = 14.8667, longitude = -61.0167 WHERE nom = 'Le Marigot';
UPDATE communes SET latitude = 14.7833, longitude = -61.1333 WHERE nom = 'Le Morne Rouge';
UPDATE communes SET latitude = 14.7167, longitude = -61.1333 WHERE nom = 'Le Morne Vert';
UPDATE communes SET latitude = 14.8000, longitude = -61.2333 WHERE nom = 'Le Prêcheur';
UPDATE communes SET latitude = 14.6767, longitude = -60.9367 WHERE nom = 'Le Robert';
UPDATE communes SET latitude = 14.5500, longitude = -60.8500 WHERE nom = 'Le Vauclin';
UPDATE communes SET latitude = 14.4967, longitude = -61.0800 WHERE nom = 'Les Anses d''Arlet';
UPDATE communes SET latitude = 14.5367, longitude = -61.0367 WHERE nom = 'Les Trois Ilets';
UPDATE communes SET latitude = 14.8667, longitude = -61.1167 WHERE nom = 'Macouba';
UPDATE communes SET latitude = 14.5533, longitude = -60.9433 WHERE nom = 'Saint Esprit';
UPDATE communes SET latitude = 14.4333, longitude = -60.8667 WHERE nom = 'Sainte Anne';
UPDATE communes SET latitude = 14.7833, longitude = -60.9833 WHERE nom = 'Sainte Marie';
