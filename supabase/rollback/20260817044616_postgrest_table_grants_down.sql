-- Rollback de 20260817044616_postgrest_table_grants.sql
--
-- 🔴 NE PAS JOUER SUR LA PRODUCTION. Lire avant toute chose.
--
-- Cette migration est un cas particulier : sur la prod, les GRANT de table existaient
-- DÉJÀ avant elle (posés hors migration, par les privilèges par défaut de Supabase). La
-- migration n'y a donc rien changé côté tables — elle n'a fait qu'inscrire l'état dans
-- l'historique et ajouter les privilèges par défaut pour les tables à venir.
--
-- Conséquence : révoquer ces droits ne « revient » pas à l'état d'avant, ça met
-- l'application HORS SERVICE. PostgREST bascule vers `anon` / `authenticated`, et sans
-- droit de table toute requête est refusée en 403 avant même que la RLS soit consultée.
-- Ce n'est pas un rollback, c'est une panne.
--
-- Le seul retour arrière qui a du sens est le retrait des privilèges par défaut : il ne
-- touche à aucune table existante, il empêche seulement les tables FUTURES d'hériter
-- automatiquement des droits. C'est la partie ci-dessous, la seule qui soit active.

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Retrait des droits sur les tables existantes — VOLONTAIREMENT COMMENTÉ.
--
-- À ne décommenter que sur une base jetable, jamais sur un environnement servant des
-- utilisateurs. Sur une base reconstruite depuis les migrations, ça la ramène à l'état
-- cassé qui a motivé cette migration ; sur la prod, ça coupe l'application.
--
-- revoke all on all tables in schema public from anon, authenticated, service_role;
-- revoke all on all sequences in schema public from anon, authenticated, service_role;
-- ─────────────────────────────────────────────────────────────────────────────

-- Contrôle : les tables gardent leurs droits, les futures n'héritent plus.
--   select count(*) from information_schema.role_table_grants
--    where table_schema='public' and grantee='authenticated' and privilege_type='SELECT';
--   select defaclacl::text from pg_default_acl d
--     join pg_namespace n on n.oid = d.defaclnamespace where n.nspname='public';
