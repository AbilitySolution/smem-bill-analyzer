"use server";

import { revalidatePath } from "next/cache";
import { getUserContext } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export async function assignUserRole(userId: string, role: "admin_smem" | "agent_commune", communeId: string | null) {
  const ctx = await getUserContext();
  if (!ctx || ctx.role !== "admin_smem") return { error: "Non autorisé." };

  const admin = createAdminClient();
  await admin.from("user_roles").upsert({ user_id: userId, role, commune_id: role === "admin_smem" ? null : communeId });

  revalidatePath("/parametres");
  return { success: true };
}

export async function createFileRequestLink(communeId: string, label: string) {
  const ctx = await getUserContext();
  if (!ctx) return { error: "Non autorisé." };
  if (ctx.role !== "admin_smem" && ctx.communeId !== communeId) {
    return { error: "Non autorisé pour cette commune." };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("file_request_links")
    .insert({ commune_id: communeId, label, created_by: ctx.userId });

  if (error) return { error: error.message };
  revalidatePath("/parametres/demandes");
  return { success: true };
}
