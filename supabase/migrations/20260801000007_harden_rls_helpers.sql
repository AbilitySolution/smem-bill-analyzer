-- current_user_org_id() et is_org_admin() sont SECURITY DEFINER mais ne fixent pas leur
-- search_path et référencent `user_roles` / `auth.uid()` sans qualifier le schéma. Deux
-- conséquences :
--
--   1. Sécurité : une fonction SECURITY DEFINER sans search_path figé peut être détournée
--      si l'appelant place un objet homonyme dans un schéma prioritaire. Ces deux fonctions
--      décident de TOUTE l'isolation multi-tenant — c'est le pire endroit où laisser ça.
--
--   2. Bug concret : toute fonction appelante qui fixe `SET search_path = ''` (bonne
--      pratique) fait échouer leur corps avec « relation "user_roles" does not exist ».
--      C'est ce qui cassait invoice_list_kpis().
--
-- Le corps est fonctionnellement identique — seuls les noms sont qualifiés.
CREATE OR REPLACE FUNCTION current_user_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT org_id FROM public.user_roles WHERE user_id = (SELECT auth.uid())
$$;

CREATE OR REPLACE FUNCTION is_org_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT role FROM public.user_roles WHERE user_id = (SELECT auth.uid())) = 'org_admin',
    false
  )
$$;
