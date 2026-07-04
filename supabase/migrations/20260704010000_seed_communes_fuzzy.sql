-- Fuzzy matching for commune names
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Seed the 20 canonical communes (safe upsert — preserves existing ids)
INSERT INTO communes (nom) VALUES
  ('Bellefontaine'),
  ('Carbet'),
  ('Case Pilote'),
  ('Ducos'),
  ('Fonds Saint Denis'),
  ('Grand Rivière'),
  ('Gros Morne'),
  ('La Trinité'),
  ('Le Marigot'),
  ('Le Morne Rouge'),
  ('Le Morne Vert'),
  ('Le Prêcheur'),
  ('Le Robert'),
  ('Le Vauclin'),
  ('Les Anses d''Arlet'),
  ('Les Trois Ilets'),
  ('Macouba'),
  ('Saint Esprit'),
  ('Sainte Anne'),
  ('Sainte Marie')
ON CONFLICT (nom) DO NOTHING;

-- Trigram index on commune names for fast similarity search
CREATE INDEX IF NOT EXISTS idx_communes_nom_trgm
  ON communes USING gin(nom gin_trgm_ops);

-- Returns the best-matching commune id for any free-text input.
-- Returns NULL if best similarity < 0.15 (completely unrecognizable input).
CREATE OR REPLACE FUNCTION match_commune(input_text text)
RETURNS TABLE(commune_id uuid, commune_nom text, score real) AS $$
  SELECT
    id          AS commune_id,
    nom         AS commune_nom,
    similarity(
      lower(unaccent(nom)),
      lower(unaccent(input_text))
    )           AS score
  FROM communes
  WHERE similarity(
    lower(unaccent(nom)),
    lower(unaccent(input_text))
  ) > 0.15
  ORDER BY score DESC
  LIMIT 1;
$$ LANGUAGE sql STABLE;
