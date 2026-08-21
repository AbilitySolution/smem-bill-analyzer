/**
 * One-off : renomme les fichiers storage existants vers le nouveau schéma de
 * chemin préfixé par organisation ({org_id}/...), après la migration SQL
 * multi-tenant. À exécuter UNE SEULE FOIS, juste après le push de la migration
 * 20260729000000_multi_tenant.sql, avant le déploiement du code applicatif qui
 * écrit/lit déjà les nouveaux chemins.
 *
 * invoice-files   : {user_id}/{filename}            → {org_id}/{user_id}/{filename}
 * pending-uploads : {commune_id}/{filename}          → {org_id}/{commune_id}/{filename}
 *
 * Usage : npx tsx scripts/migrate-storage-paths.ts [--dry]
 */
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

import { loadEnv } from "./_env";
const DRY = process.argv.includes("--dry");

async function main() {
  const env = loadEnv();
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    realtime: { transport: ws as never },
  });

  // ── invoice-files : {user_id}/... → {org_id}/{user_id}/... ──
  const { data: invoices, error: invErr } = await admin.from("invoices").select("id, file_path, org_id");
  if (invErr) throw new Error(`select invoices: ${invErr.message}`);

  let invMoved = 0;
  for (const inv of invoices ?? []) {
    if (!inv.file_path || inv.file_path.startsWith("seed-sim/") || inv.file_path.startsWith(`${inv.org_id}/`)) continue;
    const newPath = `${inv.org_id}/${inv.file_path}`;
    console.log(`invoice-files: ${inv.file_path} → ${newPath}`);
    if (DRY) continue;
    const { error: moveErr } = await admin.storage.from("invoice-files").move(inv.file_path, newPath);
    if (moveErr) { console.error(`  ✖ facture ${inv.id}: ${moveErr.message}`); continue; }
    const { error: updErr } = await admin.from("invoices").update({ file_path: newPath }).eq("id", inv.id);
    if (updErr) { console.error(`  ✖ update facture ${inv.id}: ${updErr.message}`); continue; }
    invMoved++;
  }
  console.log(`invoice-files : ${invMoved} fichier(s) déplacé(s).`);

  // ── pending-uploads : {commune_id}/... → {org_id}/{commune_id}/... ──
  const { data: pending, error: pendErr } = await admin.from("pending_uploads").select("id, file_path, org_id");
  if (pendErr) throw new Error(`select pending_uploads: ${pendErr.message}`);

  let pendMoved = 0;
  for (const p of pending ?? []) {
    if (!p.file_path || p.file_path.startsWith(`${p.org_id}/`)) continue;
    const newPath = `${p.org_id}/${p.file_path}`;
    console.log(`pending-uploads: ${p.file_path} → ${newPath}`);
    if (DRY) continue;
    const { error: moveErr } = await admin.storage.from("pending-uploads").move(p.file_path, newPath);
    if (moveErr) { console.error(`  ✖ pending ${p.id}: ${moveErr.message}`); continue; }
    const { error: updErr } = await admin.from("pending_uploads").update({ file_path: newPath }).eq("id", p.id);
    if (updErr) { console.error(`  ✖ update pending ${p.id}: ${updErr.message}`); continue; }
    pendMoved++;
  }
  console.log(`pending-uploads : ${pendMoved} fichier(s) déplacé(s).`);

  if (DRY) console.log("--dry : aucune écriture effectuée.");
}

main().catch((e) => { console.error("✖ Échec :", e.message ?? e); process.exit(1); });
