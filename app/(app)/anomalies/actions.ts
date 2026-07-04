"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function resolveAnomaly(anomalyId: string) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return { error: "Unauthorized" };

  const { error } = await supabase.from("anomalies").update({ resolved: true }).eq("id", anomalyId);
  if (error) return { error: error.message };
  revalidatePath("/anomalies");
  return { success: true };
}
