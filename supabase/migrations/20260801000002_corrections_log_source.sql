-- corrections_log ne capturait jusqu'ici QUE les ré-éditions post-enregistrement.
-- Les corrections faites pendant la revue initiale (/upload/review, avant le save) étaient
-- perdues — or c'est là que se fait l'essentiel des corrections, donc la vérité terrain la
-- plus représentative de la précision réelle de l'extraction IA.
-- `source` distingue les deux origines pour que les métriques restent interprétables.
ALTER TABLE corrections_log
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'post_save'
    CHECK (source IN ('initial_review', 'post_save'));

-- Les métriques agrègent par (table_name, field_name) sur une org : index dédié.
CREATE INDEX IF NOT EXISTS idx_corrections_log_field
  ON corrections_log (table_name, field_name);
