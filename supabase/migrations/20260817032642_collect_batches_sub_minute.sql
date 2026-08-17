-- Relève des lots Anthropic toutes les 20 s au lieu de chaque minute.
--
-- Mesuré sur 260 documents : un lot est traité par le fournisseur en ~100 s, mais la
-- relève ne tournait qu'à la minute — le résultat était donc prêt en moyenne 30 s avant
-- que quiconque le remarque. Ce délai est de l'attente pure, ajoutée à chaque document.
--
-- Le coût est négligeable : une invocation qui ne trouve aucun lot terminé sort
-- immédiatement. On triple le nombre d'appels à vide pour supprimer une demi-minute
-- d'attente sur chaque document traité.
--
-- Les deux autres crons restent à la minute :
--   - `dispatch-claude-batches` : la route d'upload réveille désormais le worker
--     directement (`after()` dans app/api/document-jobs/route.ts), le cron n'est plus
--     qu'un filet de reprise — le presser n'apporterait rien.
--   - `process-direct-documents` : même réveil immédiat côté route.
--
-- pg_cron accepte la syntaxe par intervalle depuis la 1.5 (installé ici : 1.6.4).

-- ------------------------------------------------------------------------------------
-- Préalable indispensable : empêcher deux collectes de se marcher dessus.
--
-- `list_batches_to_collect` ne faisait que LIRE les lots `in_progress` — aucun verrou,
-- aucune réservation. Le statut ne bascule qu'à la FIN de la collecte, si bien que deux
-- invocations concurrentes voyaient le même lot et téléchargeaient les mêmes résultats.
-- À la minute le problème restait théorique : une collecte se terminait avant le tick
-- suivant. À 20 s il deviendrait courant — et le vrai dégât n'est pas l'appel en double
-- mais les mêmes `document_jobs` repassés en `needs_review`, ce qui peut relancer
-- l'enregistrement automatique côté client.
--
-- `collection_started_at` était déjà écrit au début de la collecte, mais jamais relu.
-- Il devient ici un bail : un lot dont la collecte a démarré il y a moins de 5 minutes
-- n'est plus proposé. Bail plutôt que verrou, pour la propriété d'auto-guérison — une
-- invocation qui meurt en cours de route ne bloque pas son lot indéfiniment, il
-- redevient éligible à l'expiration.
--
-- 5 minutes : très au-dessus d'une collecte normale (~100 documents), assez court pour
-- qu'une reprise après incident reste imperceptible.
-- ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_batches_to_collect(batch_limit integer DEFAULT 10)
RETURNS SETOF public.document_batches
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT batch.*
  FROM public.document_batches AS batch
  WHERE batch.id IN (
    SELECT ranked.id
    FROM (
      SELECT
        candidate.id,
        candidate.created_at,
        row_number() OVER (
          PARTITION BY COALESCE(candidate.org_id, '00000000-0000-0000-0000-000000000000'::uuid)
          ORDER BY candidate.created_at
        ) AS rank_in_org
      FROM public.document_batches AS candidate
      WHERE candidate.status = 'in_progress'
        -- Bail de collecte : voir le commentaire ci-dessus.
        AND (
          candidate.collection_started_at IS NULL
          OR candidate.collection_started_at < now() - interval '5 minutes'
        )
    ) AS ranked
    ORDER BY ranked.rank_in_org, ranked.created_at
    LIMIT LEAST(GREATEST(batch_limit, 1), 50)
  );
$$;

REVOKE ALL ON FUNCTION public.list_batches_to_collect(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_batches_to_collect(integer) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'collect-claude-batches') THEN
    PERFORM cron.unschedule('collect-claude-batches');
  END IF;

  PERFORM cron.schedule(
    'collect-claude-batches', '20 seconds',
    $cron$
      SELECT net.http_post(
        url := project_url.secret || '/functions/v1/collect-document-batches',
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || service_key.secret),
        body := '{}'::jsonb
      )
      FROM
        (SELECT decrypted_secret AS secret FROM vault.decrypted_secrets WHERE name='project_url' LIMIT 1) project_url,
        (SELECT decrypted_secret AS secret FROM vault.decrypted_secrets WHERE name='service_role_key' LIMIT 1) service_key;
    $cron$
  );
END $$;
