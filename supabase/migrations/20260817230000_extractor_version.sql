-- Empreinte de l'extracteur ayant produit chaque résultat.
--
-- Motivation concrète : deux corrections de prompt déployées le 17/08/2026 (retrait d'une
-- règle HP/HC fausse, ajout d'un point de cache). Après coup, plus rien ne permettait de
-- répondre à « quelles factures ont été extraites avec l'ancienne règle ? », donc rien ne
-- permettait de cibler une réextraction. Chaque correctif de prompt laissait derrière lui
-- une strate de données dont personne ne connaissait la provenance.
--
-- La valeur est calculée côté code (`lib/anthropic/extractor-version.ts` et son miroir Deno)
-- à partir du modèle, des deux prompts et du schéma d'outil : tout ce qui change la sortie
-- change l'empreinte, sans qu'il faille penser à incrémenter quoi que ce soit.
--
-- Nullable et sans valeur par défaut : les lignes antérieures à cette migration ont été
-- produites par un extracteur inconnu, et c'est exactement ce que NULL doit dire. Leur
-- affecter rétroactivement la version courante serait une affirmation fausse.

ALTER TABLE public.document_jobs
  ADD COLUMN IF NOT EXISTS extractor_version text;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS extractor_version text;

COMMENT ON COLUMN public.document_jobs.extractor_version IS
  'Empreinte (modèle + prompts + schéma) de l''extracteur ayant produit extraction_json. NULL = antérieur au suivi.';

COMMENT ON COLUMN public.invoices.extractor_version IS
  'Empreinte de l''extracteur ayant produit raw_ocr_json. NULL = antérieur au suivi. Sert à cibler une réextraction après correction de prompt.';

-- Le cas d'usage est « toutes les factures d'une org produites par telle version » :
-- partiel sur NOT NULL, la colonne restant vide sur tout l'historique.
CREATE INDEX IF NOT EXISTS idx_invoices_extractor_version
  ON public.invoices (org_id, extractor_version)
  WHERE extractor_version IS NOT NULL;
