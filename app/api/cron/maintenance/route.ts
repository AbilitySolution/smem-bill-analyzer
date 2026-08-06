import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { matchesCronSecret } from "@/lib/ops/cron-auth";
import { notifyOps } from "@/lib/ops/notify";
import {
  awaitingAutoSaveCount, getQueueHealthAsService, stuckCount,
} from "@/lib/data/queue-health";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Maintenance quotidienne de la file de traitement documentaire.
 *
 * Trois passes, puis un digest :
 *
 *   1. Réconciliateur fournisseur — jobs terminaux qui référencent encore un fichier
 *      distant (worker tué entre la suppression et l'effacement du pointeur, ou
 *      backlog d'avant le correctif de fuite) : suppression + pointeur effacé.
 *      Rend la fuite de fichiers auto-cicatrisante.
 *   2. Purge storage — fichiers de `queue/` des jobs `failed`/`rejected_non_invoice`
 *      vieux de plus de 30 jours et sans facture associée. Jamais `completed` (la
 *      facture référence ce chemin) ni `needs_review` (revue humaine possible). La
 *      ligne `document_jobs` est conservée : c'est l'historique du client.
 *   3. Digest — envoyé UNIQUEMENT s'il y a quelque chose à dire. Un « tout va bien »
 *      quotidien apprend à ignorer le canal.
 *
 * `?dry=1` : compte tout, ne supprime rien. Seul moyen de valider une passe
 * destructive contre des données réelles avant d'activer le planning.
 *
 * Auth : `Authorization: Bearer $CRON_SECRET` exclusivement — le proxy exempte
 * `/api/cron/` de la session, chaque route vérifie donc son secret elle-même.
 */

const PURGE_AFTER_DAYS = 30;
/** Bornes par passe : garde la requête loin de `maxDuration`, le tick suivant continue. */
const MAX_RECONCILE_PER_RUN = 100;
const MAX_PURGE_PER_RUN = 200;
const PURGE_NOTICE = " · Fichier purgé après 30 jours — redéposez le document.";

const TERMINAL_STATUSES = ["failed", "completed", "rejected_non_invoice"];

async function deleteRemoteFile(fileId: string, apiKey: string): Promise<boolean> {
  // Même sémantique que `releaseRemoteFile` côté workers : ne considérer le fichier
  // libéré que s'il est prouvé absent du fournisseur (suppression réussie ou 404).
  const response = await fetch(`https://api.anthropic.com/v1/files/${fileId}`, {
    method: "DELETE",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "files-api-2025-04-14",
    },
  }).catch(() => null);
  if (!response) return false;
  return response.ok || response.status === 404;
}

async function reconcileRemoteFiles(admin: ReturnType<typeof createAdminClient>, dry: boolean) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: leaked, error } = await admin.from("document_jobs")
    .select("id, anthropic_file_id")
    .in("status", [...TERMINAL_STATUSES, "needs_review"])
    .not("anthropic_file_id", "is", null)
    .lt("updated_at", hourAgo)
    .limit(MAX_RECONCILE_PER_RUN);
  if (error || !leaked) return { candidates: 0, released: 0, error: error?.message ?? null };
  if (dry || !apiKey) return { candidates: leaked.length, released: 0, error: apiKey ? null : "ANTHROPIC_API_KEY absente" };

  let released = 0;
  for (const job of leaked as Array<{ id: string; anthropic_file_id: string }>) {
    if (!(await deleteRemoteFile(job.anthropic_file_id, apiKey))) continue;
    await admin.from("document_jobs")
      .update({ anthropic_file_id: null, updated_at: new Date().toISOString() })
      .eq("id", job.id);
    released++;
  }
  return { candidates: leaked.length, released, error: null };
}

async function purgeExpiredFiles(admin: ReturnType<typeof createAdminClient>, dry: boolean) {
  const cutoff = new Date(Date.now() - PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: expired, error } = await admin.from("document_jobs")
    .select("id, file_path, last_error")
    .in("status", ["failed", "rejected_non_invoice"])
    .is("processed_invoice_id", null)
    .lt("updated_at", cutoff)
    .not("file_path", "is", null)
    // Idempotence : un job déjà purgé porte la mention dans `last_error`.
    .not("last_error", "ilike", `%${PURGE_NOTICE.trim()}%`)
    .limit(MAX_PURGE_PER_RUN);
  if (error || !expired) return { candidates: 0, purged: 0, error: error?.message ?? null };
  if (dry) return { candidates: expired.length, purged: 0, error: null };

  let purged = 0;
  for (const job of expired as Array<{ id: string; file_path: string; last_error: string | null }>) {
    const { error: removeError } = await admin.storage.from("invoice-files").remove([job.file_path]);
    if (removeError) {
      console.error("[maintenance] purge impossible", { id: job.id, error: removeError.message });
      continue;
    }
    await admin.from("document_jobs")
      .update({
        last_error: `${(job.last_error ?? "").slice(0, 800)}${PURGE_NOTICE}`,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    purged++;
  }
  return { candidates: expired.length, purged, error: null };
}

export async function GET(request: Request) {
  if (!matchesCronSecret(request.headers.get("authorization") ?? "")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dry = new URL(request.url).searchParams.get("dry") === "1";
  const admin = createAdminClient();

  const reconcile = await reconcileRemoteFiles(admin, dry);
  const purge = await purgeExpiredFiles(admin, dry);

  // ── Digest conditionnel ────────────────────────────────────────────────────────
  const health = await getQueueHealthAsService();
  let digestSent = false;
  if (!dry && health) {
    const stuck = stuckCount(health.live);
    const awaiting = awaitingAutoSaveCount(health.live);
    const lines: string[] = [];
    if (stuck > 0) lines.push(`⚠️ ${stuck} document(s) bloqué(s) dans la file.`);
    if (health.failures24h > 0) {
      const topErrors = [...new Set(
        health.recentFailures.map((failure) => failure.last_error?.slice(0, 120)).filter(Boolean),
      )].slice(0, 3);
      lines.push(`❌ ${health.failures24h} échec(s) sur 24 h.${topErrors.length ? ` Erreurs : ${topErrors.join(" | ")}` : ""}`);
    }
    if (awaiting > 0) lines.push(`⏳ ${awaiting} document(s) en attente d'enregistrement automatique depuis > 10 min — vérifier le Cron auto-save.`);
    if (reconcile.released > 0) lines.push(`🧹 ${reconcile.released} fichier(s) distant(s) libéré(s).`);
    if (purge.purged > 0) lines.push(`🗑️ ${purge.purged} fichier(s) purgé(s) du stockage (> ${PURGE_AFTER_DAYS} j).`);

    if (lines.length > 0) {
      await notifyOps(`Maintenance documentaire — ${new Date().toISOString().slice(0, 10)}\n${lines.join("\n")}`);
      digestSent = true;
    }
  }

  // Dead-man's switch optionnel : un moniteur externe (healthchecks.io ou équivalent)
  // alerte si ce ping cesse — la seule alerte encore valide quand NOTRE infra est morte.
  if (!dry && process.env.OPS_HEARTBEAT_URL) {
    await fetch(process.env.OPS_HEARTBEAT_URL).catch(() => null);
  }

  return NextResponse.json({ dry, reconcile, purge, digestSent });
}
