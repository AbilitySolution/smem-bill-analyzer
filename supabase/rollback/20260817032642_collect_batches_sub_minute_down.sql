-- Rollback de 20260817032642_collect_batches_sub_minute.sql
--
-- La migration fait deux choses : elle accélère le cron de collecte (1 min → 20 s) et
-- elle pose un bail sur `list_batches_to_collect` pour que deux collectes concurrentes ne
-- se marchent pas dessus.
--
-- ⚠️ CE ROLLBACK NE REVIENT QUE SUR LA CADENCE. Le bail reste en place, délibérément.
--
-- Le retirer rétablirait le défaut qu'il corrige : `list_batches_to_collect` ne faisait
-- que LIRE les lots `in_progress`, sans réservation, et le statut ne bascule qu'à la fin
-- de la collecte. Deux invocations concurrentes voyaient donc le même lot et
-- retéléchargeaient les mêmes résultats — repassant les mêmes `document_jobs` en
-- `needs_review`, avec le risque de relancer l'enregistrement automatique côté client.
--
-- À la minute ce défaut redevient improbable, mais il n'est pas théorique pour autant, et
-- le bail ne coûte rien : un lot dont la collecte a démarré il y a plus de 5 minutes
-- redevient éligible tout seul. Il n'y a aucune raison de le retirer avec la cadence.
--
-- Effet du rollback : les factures remontent jusqu'à 40 s plus tard. Aucun lot perdu,
-- aucune donnée touchée.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'collect-claude-batches') THEN
    PERFORM cron.unschedule('collect-claude-batches');
  END IF;

  PERFORM cron.schedule(
    'collect-claude-batches', '* * * * *',
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

-- Contrôle : schedule = '* * * * *', et le bail toujours présent dans la fonction.
--   select jobname, schedule, active from cron.job where jobname = 'collect-claude-batches';
--   select pg_get_functiondef(oid) like '%collection_started_at%' as bail_present
--     from pg_proc where proname = 'list_batches_to_collect';
