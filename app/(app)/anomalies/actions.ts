"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/** Résolu/rouvert en DB (partagé entre membres de l'org), plus en localStorage navigateur. */
export async function setAnomalyResolved(anomalyId: string, resolved: boolean) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return { error: "Unauthorized" };

  const { error } = await supabase.from("anomalies").update({ resolved }).eq("id", anomalyId);
  if (error) return { error: error.message };
  revalidatePath("/anomalies");
  return { success: true };
}

export async function resolveAnomaly(anomalyId: string) {
  return setAnomalyResolved(anomalyId, true);
}
