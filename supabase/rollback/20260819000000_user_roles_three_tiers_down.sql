-- Rollback de 20260819000000_user_roles_three_tiers.sql
--
-- 🟠 PERTE DE DONNÉES PARTIELLE — lire avant d'exécuter.
--
-- Ce qui est perdu et ne revient pas : la distinction Superviseur / Membre. Tout
-- org_supervisor redevient org_member (rétrogradation, jamais promotion : remonter un
-- superviseur en admin lui donnerait des droits qu'il n'a jamais eus). Relever la liste
-- AVANT d'exécuter, elle n'est reconstituable par aucun autre moyen :
--
--   select u.email, r.role from public.user_roles r
--     join auth.users u on u.id = r.user_id
--    where r.role = 'org_supervisor';
--
-- ⚠️ PRÉREQUIS : redéployer d'abord le code SANS les rôles à trois niveaux. Sinon
-- lib/authz.ts continue d'attendre 'org_supervisor' et le sélecteur de /parametres
-- proposera une valeur que le CHECK refuse.

BEGIN;

-- 1. Verrou « dernier administrateur ». Retiré en premier : il refuserait certaines des
--    rétrogradations de l'étape 2 si une organisation n'avait qu'un admin.
DROP TRIGGER IF EXISTS trg_prevent_last_admin_removal ON public.user_roles;
DROP FUNCTION IF EXISTS public.prevent_last_admin_removal();

-- 2. Helper RLS. À ne supprimer qu'après avoir vérifié qu'aucune policy ne l'appelle
--    encore — un DROP sur une fonction référencée échoue, c'est le comportement voulu :
--      select polname, pg_get_expr(polqual, polrelid) from pg_policy
--       where pg_get_expr(polqual, polrelid) like '%is_org_supervisor%';
DROP FUNCTION IF EXISTS public.is_org_supervisor();

-- 3. Rétrogradation des superviseurs, obligatoire avant de resserrer le CHECK.
UPDATE public.user_roles SET role = 'org_member' WHERE role = 'org_supervisor';

-- 4. CHECK à deux valeurs, tel que posé par 20260729000000_multi_tenant.sql.
ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;
ALTER TABLE public.user_roles ADD  CONSTRAINT user_roles_role_check
  CHECK (role IN ('org_admin','org_member'));

-- 5. Défaut retiré : avant la migration la colonne n'en avait pas, un INSERT sans rôle
--    échouait sur le NOT NULL. On restaure cet échec franc.
ALTER TABLE public.user_roles ALTER COLUMN role DROP DEFAULT;

COMMIT;

-- Ce qui n'est PAS annulé, à dessein : la promotion en org_admin des comptes qui étaient
-- org_member avant la migration (étape 1 de la migration). Leur rôle d'origine n'est
-- conservé nulle part, et rétrograder à l'aveugle risquerait de retirer à quelqu'un un
-- accès dont il dépend depuis. À traiter à la main si nécessaire.

-- Contrôle final :
--   select role, count(*) from public.user_roles group by role;  -- aucun org_supervisor
--   select column_default from information_schema.columns
--    where table_name = 'user_roles' and column_name = 'role';   -- NULL
