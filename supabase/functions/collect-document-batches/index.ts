// Collecteur du mode `batch` : interroge les lots en cours et, une fois terminés,
// télécharge les résultats JSONL et passe chaque job en `needs_review`.
//
// Invoqué par le Cron `collect-claude-batches` toutes les minutes.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { releaseRemoteFile } from "../_shared/ai-client.ts";
import { toUserSafeError } from "../_shared/ai-error.ts";
import { isServiceToken } from "../_shared/service-token.ts";

type BatchLine = {
  custom_id: string;
  result: {
    type: "succeeded" | "errored" | "canceled" | "expired";
    message?: { content?: Array<{ type: string; input?: unknown }>; usage?: Record<string, number> };
    error?: { error?: { message?: string }; message?: string };
  };
};

type BatchRow = {
  id: string;
  anthropic_batch_id: string;
};

/**
 * Lots inspectés par tick de Cron.
 *
 * Un lot contient désormais jusqu'à `TARGET_BATCH_SIZE` documents (50) au lieu de 5 :
 * ces 10 lots représentent ~500 documents collectés par minute, contre 50 auparavant.
 */
const MAX_BATCHES_PER_INVOCATION = 10;
/** Documents traités en parallèle à l'intérieur d'un lot. */
const LINE_CONCURRENCY = 5;

async function mapWithConcurrency<T, R>(values: T[], limit: number, worker: (value: T) => Promise<R>) {
  const results: R[] = new Array(values.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await worker(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => run()));
  return results;
}

function extractionFromResult(line: BatchLine) {
  if (line.result.type !== "succeeded") {
    throw new Error(line.result.error?.error?.message ?? line.result.error?.message ?? `Résultat d'extraction ${line.result.type}`);
  }
  const toolUse = line.result.message?.content?.find((block) => block.type === "tool_use");
  if (!toolUse?.input || typeof toolUse.input !== "object") throw new Error("L'extraction structurée n'a pas été retournée.");
  const value = toolUse.input as Record<string, unknown>;
  // Contrôle minimal ici ; la validation complète (zod) se fait à la lecture du job.
  for (const key of ["client", "contract", "invoice", "fixed_charges", "consumption_lines", "taxes"]) {
    if (!(key in value)) throw new Error(`Extraction incomplète : ${key} est absent.`);
  }
  return value;
}

async function aiStatusRequest(path: string, apiKey: string) {
  return fetch(`https://api.anthropic.com${path}`, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "files-api-2025-04-14",
    },
  });
}

async function collectBatch(
  batch: BatchRow,
  supabase: ReturnType<typeof createClient>,
  apiKey: string,
) {
  const statusResponse = await aiStatusRequest(`/v1/messages/batches/${batch.anthropic_batch_id}`, apiKey);
  if (!statusResponse.ok) {
    const detail = await statusResponse.text();
    const { userMessage, logMessage } = toUserSafeError(new Error(detail));
    console.error(`[collect-document-batches] batch ${batch.anthropic_batch_id} status error:`, logMessage);
    await supabase.from("document_batches").update({ last_error: userMessage.slice(0, 1000), updated_at: new Date().toISOString() }).eq("id", batch.id);
    throw new Error(detail);
  }
  const remoteBatch = await statusResponse.json();
  const anthropicEndedAt = remoteBatch.ended_at ?? null;
  await supabase.from("document_batches").update({ request_counts: remoteBatch.request_counts, anthropic_ended_at: anthropicEndedAt, updated_at: new Date().toISOString() }).eq("id", batch.id);
  if (remoteBatch.processing_status !== "ended") {
    return { processed: false, batch_id: batch.anthropic_batch_id, status: remoteBatch.processing_status };
  }

  const collectionStartedAt = new Date().toISOString();
  await supabase.from("document_batches").update({ collection_started_at: collectionStartedAt, updated_at: collectionStartedAt }).eq("id", batch.id);
  const resultsResponse = await aiStatusRequest(`/v1/messages/batches/${batch.anthropic_batch_id}/results`, apiKey);
  if (!resultsResponse.ok) throw new Error(await resultsResponse.text());
  const jsonl = await resultsResponse.text();
  const lines = jsonl.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as BatchLine);

  let succeeded = 0;
  let failed = 0;
  // Traitement concurrent : un lot contient désormais jusqu'à 50 documents au lieu de 5,
  // et chacun coûte ~4 allers-retours base plus une suppression de fichier chez le
  // fournisseur. En série, une invocation de 10 lots dépasserait la minute du Cron.
  const outcomes = await mapWithConcurrency(lines, LINE_CONCURRENCY, async (line) => {
    const { data: job } = await supabase.from("document_jobs").select("id, anthropic_file_id").eq("id", line.custom_id).maybeSingle();
    if (!job) return "skipped" as const;
    let outcome: "succeeded" | "failed";
    try {
      const extraction = extractionFromResult(line);
      const resultAvailableAt = new Date().toISOString();
      await supabase.from("document_jobs").update({
        status: "needs_review", extraction_json: extraction,
        validation_json: { anthropic_usage: line.result.message?.usage ?? null },
        completed_at: resultAvailableAt, result_available_at: resultAvailableAt,
        updated_at: resultAvailableAt, last_error: null,
      }).eq("id", job.id);
      outcome = "succeeded";
    } catch (error) {
      const { userMessage, logMessage } = toUserSafeError(error);
      console.error(`[collect-document-batches] job ${job.id} failed:`, logMessage);
      await supabase.from("document_jobs").update({
        status: "failed", last_error: userMessage, updated_at: new Date().toISOString(),
      }).eq("id", job.id);
      outcome = "failed";
    }
    // Dans tous les cas : le fichier distant est supprimé, pas de fuite côté fournisseur.
    await releaseRemoteFile(supabase, job.id, apiKey);
    return outcome;
  });
  succeeded = outcomes.filter((outcome) => outcome === "succeeded").length;
  failed = outcomes.filter((outcome) => outcome === "failed").length;

  // Un lot terminé n'est plus jamais relu : tout job encore `batched` ici n'a pas de
  // ligne de résultat (requête expirée, annulée, absente du JSONL). Sans cette clôture,
  // il restait « Extraction en cours » indéfiniment — non terminal, donc la page d'import
  // le sondait sans fin et l'utilisateur n'avait aucun moyen de le relancer.
  const orphanError = "Résultat absent du lot terminé — relancez le document.";
  const { data: orphans } = await supabase.from("document_jobs")
    .select("id, anthropic_file_id")
    .eq("anthropic_batch_id", batch.anthropic_batch_id)
    .eq("status", "batched");
  for (const orphan of (orphans ?? []) as Array<{ id: string; anthropic_file_id: string | null }>) {
    console.error(`[collect-document-batches] job ${orphan.id} sans résultat dans ${batch.anthropic_batch_id}`);
    await supabase.from("document_jobs").update({
      status: "failed", last_error: orphanError, updated_at: new Date().toISOString(),
    }).eq("id", orphan.id).eq("status", "batched");
    await releaseRemoteFile(supabase, orphan.id, apiKey);
    failed++;
  }

  const resultAvailableAt = new Date().toISOString();
  await supabase.from("document_batches").update({
    // `failed === lines.length` marquait aussi « failed » un lot vide (0 === 0) et ne
    // tenait pas compte des jobs orphelins comptés hors `lines`.
    status: succeeded === 0 ? "failed" : "ended",
    request_counts: remoteBatch.request_counts,
    anthropic_ended_at: anthropicEndedAt,
    completed_at: resultAvailableAt,
    result_available_at: resultAvailableAt,
    updated_at: resultAvailableAt,
    last_error: failed ? `${failed} document(s) en erreur` : null,
  }).eq("id", batch.id);

  return { processed: true, batch_id: batch.anthropic_batch_id, succeeded, failed };
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    serviceRoleKey,
    { auth: { persistSession: false } },
  );
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY")!;

  // Réservé au Cron. Le collecteur balaie les lots de TOUTES les organisations : il n'a
  // pas de périmètre utilisateur possible, donc un jeton utilisateur n'a rien à y faire.
  // `verify_jwt = true` laissait passer n'importe quel compte authentifié.
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!isServiceToken(token, serviceRoleKey)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  // Tourniquet par organisation, comme au dispatch. Le `ORDER BY created_at LIMIT 10`
  // précédent était un FIFO strict : un client dont les lots sont les plus récents
  // attendait derrière tous ceux des autres — exactement le couplage corrigé côté
  // dispatch, laissé intact côté collecte.
  const { data: batches, error: batchError } = await supabase
    .rpc("list_batches_to_collect", { batch_limit: MAX_BATCHES_PER_INVOCATION });
  if (batchError) return Response.json({ error: batchError.message }, { status: 500 });
  if (!batches?.length) return Response.json({ processed: false, message: "Aucun batch actif" });

  const results = await Promise.allSettled((batches as BatchRow[]).map((batch) => collectBatch(batch, supabase, apiKey)));
  const failures = results.filter((result) => result.status === "rejected").map((result) => toUserSafeError(result.status === "rejected" ? result.reason : null).userMessage);
  return Response.json({
    processed: results.some((result) => result.status === "fulfilled" && result.value.processed),
    checked: batches.length,
    results: results.filter((result) => result.status === "fulfilled").map((result) => result.value),
    errors: failures,
    duration_ms: Date.now() - startedAt,
  }, { status: failures.length === batches.length ? 503 : 200 });
});
