-- La table organizations a été créée dans la migration multi-tenant (20260729000000) mais
-- la RLS n'a jamais été activée dessus — oubli : toutes les autres tables org-scopées l'ont,
-- pas celle-ci. Résultat concret : n'importe quel utilisateur authentifié pouvait lister
-- TOUTES les organisations (toutes les entreprises clientes) via l'API Supabase, alors que
-- le principe du multi-tenant est justement qu'un client ne voit que sa propre org.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

-- Lecture : uniquement sa propre org.
CREATE POLICY "org_read_organizations" ON organizations
  FOR SELECT USING (id = current_user_org_id());

-- Modification (ex. renommer l'org) : uniquement un org_admin, sur sa propre org.
CREATE POLICY "org_admin_update_organizations" ON organizations
  FOR UPDATE USING (id = current_user_org_id() AND is_org_admin())
  WITH CHECK    (id = current_user_org_id() AND is_org_admin());

-- Pas de policy INSERT/DELETE : la création d'une org se fait exclusivement via
-- scripts/provision-org.ts (clé service-role, qui contourne la RLS) — aucun flow
-- applicatif ne doit permettre à un client de créer ou supprimer une organisation.
