-- Collecte des lots Claude toutes les 20 secondes au lieu d'une fois par minute.
--
-- ⚠️ MIGRATION RECONSTITUÉE A POSTERIORI. Le changement a été appliqué directement sur la
-- production le 2026-08-17 (version 20260817032642 dans supabase_migrations) sans passer
-- par un fichier versionné. Ce fichier a été écrit en relevant l'état réel de
-- `cron.job` en prod, pour que le repo redécrive la base — sans quoi toute reconstruction
-- d'environnement depuis `main` repartirait avec l'ancien rythme.
--
-- Écart constaté par rapport à 20260805000000_document_queue.sql : le `schedule` du job
-- `collect-claude-batches` seul. Le corps de la commande est identique au caractère près,
-- et les jobs `dispatch-claude-batches` et `process-direct-documents` restent en
-- '* * * * *'.
--
-- pg_cron accepte depuis la 1.5 un intervalle en secondes à la place d'une expression
-- cron à 5 champs. Le minimum praticable est 1 seconde ; 20 secondes divise par trois le
-- délai entre la fin d'un lot chez Anthropic et sa collecte, sans tripler la charge utile
-- (la fonction sort immédiatement quand aucun lot n'est prêt).

DO $$
DECLARE existing_job bigint;
BEGIN
  -- cron.schedule() sur un nom existant met à jour le job, mais on passe par un
  -- unschedule explicite pour rester aligné sur le style de document_queue.sql et pour
  -- que rejouer ce fichier soit sans effet de bord.
  FOR existing_job IN
    SELECT jobid FROM cron.job WHERE jobname = 'collect-claude-batches'
  LOOP
    PERFORM cron.unschedule(existing_job);
  END LOOP;

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

-- Contrôle : doit renvoyer une ligne, schedule = '20 seconds', active = true.
--   select jobname, schedule, active from cron.job where jobname = 'collect-claude-batches';
