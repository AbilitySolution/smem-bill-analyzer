-- Rollback de 20260817032642_collect_batches_sub_minute.sql
--
-- Remet la collecte des lots Claude à une fois par minute, le rythme de
-- 20260805000000_document_queue.sql.
--
-- Risque nul : le job n'est jamais supprimé, seul son `schedule` revient en arrière. Aucun
-- lot en vol n'est perdu — la collecte est simplement moins fréquente, donc les factures
-- mettent jusqu'à une minute de plus à remonter au lieu de vingt secondes.
--
-- Ne PAS jouer ce rollback en même temps que celui de document_queue : celui-ci
-- reprogramme un job que l'autre supprime. Dérouler dans l'ordre du README.

DO $$
DECLARE existing_job bigint;
BEGIN
  FOR existing_job IN
    SELECT jobid FROM cron.job WHERE jobname = 'collect-claude-batches'
  LOOP
    PERFORM cron.unschedule(existing_job);
  END LOOP;

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

-- Contrôle : schedule = '* * * * *'.
--   select jobname, schedule, active from cron.job where jobname = 'collect-claude-batches';
