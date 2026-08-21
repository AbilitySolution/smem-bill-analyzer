import { createClient } from "@/lib/supabase/server";
import { hasAtLeast } from "@/lib/authz";
import type { UserRole } from "@/lib/types/database";

export interface UserContext {
  userId: string;
  email: string | null;
  orgId: string;
  role: UserRole;
  /** Informatif seulement (prefill UI) — n'est plus une frontière de sécurité, l'isolation se fait par orgId. */
  communeId: string | null;
}

export async function getUserContext(): Promise<UserContext | null> {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return null;

  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role, org_id, commune_id")
    .eq("user_id", authData.user.id)
    .maybeSingle();

  // Un utilisateur sans ligne user_roles / sans org_id est un état de provisioning
  // incomplet — on refuse l'accès plutôt que de le traiter comme un membre par défaut.
  if (!roleRow || !roleRow.org_id) return null;

  return {
    userId: authData.user.id,
    email: authData.user.email ?? null,
    orgId: roleRow.org_id,
    role: roleRow.role as UserRole,
    communeId: roleRow.commune_id ?? null,
  };
}

/**
 * Contexte utilisateur si — et seulement si — le rôle atteint le niveau demandé.
 *
 * Ne redirige pas : c'est la forme attendue par les routes API, qui doivent répondre un
 * statut HTTP et non un Location. Les pages utilisent `requireRole()` (lib/auth-guard.ts).
 */
export async function getUserContextWithRole(required: UserRole): Promise<UserContext | null> {
  const ctx = await getUserContext();
  if (!ctx || !hasAtLeast(ctx.role, required)) return null;
  return ctx;
}
