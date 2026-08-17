-- Droits de table pour les rôles PostgREST.
--
-- Les migrations du repo ne posaient que des GRANT sur des FONCTIONS. Les privilèges de
-- TABLE de la production n'ont jamais été versionnés : ils viennent des privilèges par
-- défaut de Supabase, appliqués hors migration. Une base reconstruite depuis
-- `supabase/migrations/` naissait donc sans SELECT/INSERT/UPDATE/DELETE pour `anon`,
-- `authenticated` et `service_role` — mesuré le 2026-08-16 sur un stack local neuf, où
-- `GET /rest/v1/communes` répondait 403 alors que les 30 migrations passaient au vert.
--
-- PostgREST se connecte en `authenticator` puis bascule vers `anon` / `authenticated`. Sans
-- droit de table, la requête est refusée AVANT que la RLS soit consultée. La RLS reste la
-- seule chose qui filtre les lignes ; ces GRANT ne l'affaiblissent pas, ils rendent
-- simplement la table atteignable — c'est le modèle Supabase.
--
-- ⚠️ LES FONCTIONS SONT VOLONTAIREMENT EXCLUES. Postgres accorde déjà EXECUTE à PUBLIC à la
--    création, et plusieurs migrations le RÉVOQUENT ensuite délibérément pour les fonctions
--    SECURITY DEFINER de la file de traitement (claim_document_jobs, claim_fair_document_jobs,
--    claim_org_document_jobs, list_batches_to_collect…). Un `GRANT ALL ON ALL ROUTINES` ici,
--    exécuté APRÈS ces migrations, les rouvrirait à anon et authenticated. Vérifié en prod :
--    ces fonctions y sont bien inaccessibles aux deux rôles. Ne pas ajouter les routines.

grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;

-- Pour que les tables créées par les MIGRATIONS À VENIR héritent des mêmes droits sans
-- qu'on ait à y penser. Reproduit la configuration déjà présente en prod.
alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;
