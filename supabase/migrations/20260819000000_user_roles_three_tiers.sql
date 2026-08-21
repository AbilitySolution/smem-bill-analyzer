-- Trois niveaux d'accès : org_admin > org_supervisor > org_member.
--
-- Les valeurs org_admin / org_member sont CONSERVÉES telles quelles. Les renommer
-- obligerait à réécrire is_org_admin(), current_user_org_id() et toutes les policies RLS
-- qui les appellent, pour un gain purement cosmétique : le libellé français est déjà
-- découplé de la valeur technique côté application (ROLE_LABELS dans lib/authz.ts).
--
-- Tout tient dans une transaction unique : entre la promotion des comptes existants et le
-- resserrage du CHECK, la table est dans un état intermédiaire qu'aucune session
-- concurrente ne doit pouvoir observer.
BEGIN;

-- 1. Promotion des comptes existants.
--    Consigne client : tout compte présent au moment du déploiement est Administrateur.
--    Ce sont les comptes créés APRÈS qui héritent du défaut « membre » posé en 3.
--    En production une seule ligne est concernée (ahmed.benothman@llive.fr) ; sa
--    conservation a été confirmée le 19/08/2026, il n'y a pas de cas particulier.
UPDATE public.user_roles SET role = 'org_admin' WHERE role <> 'org_admin';

-- 2. Le CHECK accepte le nouveau rôle intermédiaire.
ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;
ALTER TABLE public.user_roles ADD  CONSTRAINT user_roles_role_check
  CHECK (role IN ('org_admin','org_supervisor','org_member'));

-- 3. Défaut au niveau le plus bas : un INSERT qui omet le rôle (flux d'invitation) crée un
--    membre. Le principe est celui du moindre privilège — une erreur de provisionnement
--    doit produire un compte trop restreint, jamais un compte trop puissant.
ALTER TABLE public.user_roles ALTER COLUMN role SET DEFAULT 'org_member';

-- 4. Helper RLS pour les tables de pilotage qualité.
--    Calqué sur is_org_admin() (20260801000007_harden_rls_helpers.sql) : SECURITY DEFINER
--    avec search_path figé, schémas qualifiés, (SELECT auth.uid()) pour que le planificateur
--    n'évalue l'appel qu'une fois par requête au lieu d'une fois par ligne.
--
--    is_org_admin() n'est VOLONTAIREMENT pas touchée : elle reste une comparaison stricte à
--    'org_admin'. L'élargir ferait hériter le superviseur, d'un seul coup et sans revue, de
--    tous les droits d'écriture admin déjà posés par les policies existantes.
CREATE OR REPLACE FUNCTION public.is_org_supervisor()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT role FROM public.user_roles WHERE user_id = (SELECT auth.uid()))
      IN ('org_admin','org_supervisor'),
    false
  )
$$;

-- 5. Verrou « dernier administrateur ».
--    Sans lui, un admin qui se rétrograde depuis /parametres rend son organisation
--    ingérable : plus personne ne peut réattribuer les rôles, et la remise en état exige
--    une intervention manuelle en base. La garde applicative existe aussi côté Server
--    Action (message lisible) ; celle-ci est le filet, car assignUserRole() passe par le
--    client service-role qui contourne la RLS.
CREATE OR REPLACE FUNCTION public.prevent_last_admin_removal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Un trigger BEFORE doit renvoyer NEW sur UPDATE (renvoyer OLD annulerait
  -- silencieusement la modification) et OLD sur DELETE (renvoyer NULL l'annulerait).
  IF TG_OP = 'DELETE' THEN
    IF OLD.role = 'org_admin' AND NOT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE org_id = OLD.org_id AND role = 'org_admin' AND user_id <> OLD.user_id
    ) THEN
      RAISE EXCEPTION 'Impossible de retirer le dernier administrateur de l''organisation.';
    END IF;
    RETURN OLD;
  END IF;

  -- Seule la perte du rôle admin peut vider l'organisation de ses administrateurs ; un
  -- changement de commune ou d'org sur une ligne non-admin ne concerne pas ce verrou.
  IF OLD.role = 'org_admin' AND NEW.role <> 'org_admin' AND NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE org_id = OLD.org_id AND role = 'org_admin' AND user_id <> OLD.user_id
  ) THEN
    RAISE EXCEPTION 'Impossible de retirer le dernier administrateur de l''organisation.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_last_admin_removal ON public.user_roles;
CREATE TRIGGER trg_prevent_last_admin_removal
  BEFORE UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_last_admin_removal();

COMMIT;

-- Contrôle après application :
--   select role, count(*) from public.user_roles group by role;   -- que des org_admin
--   select pg_get_expr(conbin, conrelid) from pg_constraint where conname = 'user_roles_role_check';
