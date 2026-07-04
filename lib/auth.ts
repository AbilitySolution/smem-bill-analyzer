import { createClient } from "@/lib/supabase/server";
import type { UserRole } from "@/lib/types/database";

export interface UserContext {
  userId: string;
  email: string | null;
  role: UserRole;
  communeId: string | null;
}

export async function getUserContext(): Promise<UserContext | null> {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return null;

  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role, commune_id")
    .eq("user_id", authData.user.id)
    .maybeSingle();

  return {
    userId: authData.user.id,
    email: authData.user.email ?? null,
    role: (roleRow?.role as UserRole) ?? "agent_commune",
    communeId: roleRow?.commune_id ?? null,
  };
}
