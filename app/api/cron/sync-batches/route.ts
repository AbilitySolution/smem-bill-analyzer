import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncBatch } from "@/lib/batches/sync";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Nombre de lots traités par passage — borne la durée d'exécution. */
const MAX_BATCHES_PER_RUN = 5;

/**
 * Reprise des lots en cours, toutes organisations confondues.
 *
 * L'API Message Batches est asynchrone : si l'utilisateur ferme l'onglet avant la fin,
 * plus personne n'appelle `/api/batches/[id]/sync` et le lot resterait indéfiniment
 * chez Anthropic sans être importé. Ce point d'entrée est le filet.
 *
 * Client service-role : il n'y a pas de session utilisateur ici, donc pas d'`auth.uid()`
 * et la RLS ne peut pas s'appliquer. C'est justifié par le fait que la fonction ne prend
 * aucun paramètre d'appelant — elle ne peut agir que sur les lots déjà en base — mais
 * l'endpoint DOIT rester protégé par le secret ci-dessous.
 */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET non configuré." }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  const { data: batches, error } = await supabase
    .from("extraction_batches")
    .select("id")
    .in("status", ["submitted", "importing"])
    .not("anthropic_batch_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(MAX_BATCHES_PER_RUN);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results: Array<{ batch_id: string; status: string; imported?: number; error?: string }> = [];

  for (const batch of batches ?? []) {
    try {
      const outcome = await syncBatch(supabase, batch.id);
      results.push({ batch_id: batch.id, status: outcome.status, imported: outcome.imported });
    } catch (err) {
      // Un lot en échec ne doit pas empêcher les suivants d'être traités.
      const message = err instanceof Error ? err.message : "erreur inconnue";
      console.error("[cron/sync-batches] lot en échec", { batchId: batch.id, error: message });
      results.push({ batch_id: batch.id, status: "failed", error: message });
    }
  }

  return NextResponse.json({ processed: results.length, results });
}

// Vercel Cron invoque le chemin en **GET** — n'exposer que POST renverrait 405 et le
// lot ne serait jamais repris. POST reste accepté pour un appel manuel ou un
// planificateur externe (cron système, Render, GitHub Actions…).
export const GET = handle;
export const POST = handle;
