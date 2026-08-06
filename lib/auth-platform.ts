import { getUserContext, type UserContext } from "@/lib/auth";

/**
 * Opérateur de la plateforme : un membre de l'organisation Ability.
 *
 * Ability opère la plateforme ; les autres organisations (SMEM, …) sont des clients.
 * Le périmètre opérateur est l'appartenance à l'org Ability, identifiée par la variable
 * d'environnement `PLATFORM_OPERATOR_ORG_ID` (UUID de l'organisation).
 *
 * Pourquoi une variable d'environnement et PAS une colonne `platform_admin` en base :
 * la policy `org_admin_write_user_roles` donne aux org_admin un `FOR ALL` sur les
 * lignes de leur organisation — une colonne de privilège sur `user_roles` serait
 * auto-attribuable par un admin client via PostgREST (escalade en une requête). La
 * variable vit hors de la base : aucune erreur SQL ne peut conférer le privilège.
 *
 * L'arrivée ou le départ d'un opérateur se gère comme n'importe quel membre de l'org
 * Ability — pas de redéploiement.
 *
 * Variable absente → personne n'est opérateur (échec fermé).
 */
export async function getPlatformOperator(): Promise<UserContext | null> {
  const operatorOrgId = process.env.PLATFORM_OPERATOR_ORG_ID?.trim();
  if (!operatorOrgId) return null;
  const ctx = await getUserContext();
  if (!ctx || ctx.orgId !== operatorOrgId) return null;
  return ctx;
}
