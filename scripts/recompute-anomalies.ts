/**
 * Recalcule les anomalies "portefeuille" (coût kWh vs médiane, pic de
 * consommation saisonnier, conso manquante) pour une organisation — utile
 * pour backfiller après import en masse (ex. scripts/seed-test-invoices.ts,
 * qui insère directement en DB sans passer par POST /api/invoices).
 *
 * Usage : npx tsx scripts/recompute-anomalies.ts [--org "Nom Org"]
 * Défaut : SMEM.
 */
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { recomputeAndPersistAnomalies } from "../lib/anomalies/persist";

import { loadEnv } from "./_env";
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const orgName = arg("--org") ?? "SMEM";
  const env = loadEnv();
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    realtime: { transport: ws as never },
  });

  const { data: org, error: orgErr } = await supabase.from("organizations").select("id").eq("nom", orgName).maybeSingle();
  if (orgErr || !org) throw new Error(`Organisation "${orgName}" introuvable: ${orgErr?.message ?? "aucune ligne"}`);

  const { computed, preserved } = await recomputeAndPersistAnomalies(supabase, org.id);

  const byType = new Map<string, number>();
  for (const c of computed) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);

  console.log(`✔ ${computed.length} anomalie(s) recalculée(s) pour "${orgName}" (${preserved} statut(s) résolu(e) préservé(s)) :`);
  for (const [type, count] of byType) console.log(`  - ${type} : ${count}`);
}

main().catch((e) => { console.error("✖ Échec :", e.message ?? e); process.exit(1); });
