"use server";

import { revalidatePath } from "next/cache";
import { getUserContext } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export async function assignUserRole(userId: string, role: "org_admin" | "org_member", communeId: string | null) {
  const ctx = await getUserContext();
  if (!ctx || ctx.role !== "org_admin") return { error: "Non autorisé." };

  const admin = createAdminClient();
  const { data: existing } = await admin.from("user_roles").select("org_id").eq("user_id", userId).maybeSingle();
  if (existing && existing.org_id !== ctx.orgId) {
    return { error: "Cet utilisateur appartient déjà à une autre organisation." };
  }

  await admin.from("user_roles").upsert({
    user_id: userId,
    role,
    org_id: ctx.orgId,
    commune_id: role === "org_admin" ? null : communeId,
  });

  revalidatePath("/parametres");
  return { success: true };
}

export async function createFileRequestLink(communeId: string, label: string) {
  const ctx = await getUserContext();
  if (!ctx) return { error: "Non autorisé." };

  const admin = createAdminClient();
  const { error } = await admin
    .from("file_request_links")
    .insert({ commune_id: communeId, label, created_by: ctx.userId, org_id: ctx.orgId });

  if (error) return { error: error.message };
  revalidatePath("/parametres/demandes");
  return { success: true };
}
