import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

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

function extractionFromResult(line: BatchLine) {
  if (line.result.type !== "succeeded") {
    throw new Error(line.result.error?.error?.message ?? line.result.error?.message ?? `Résultat Claude ${line.result.type}`);
  }
  const toolUse = line.result.message?.content?.find((block) => block.type === "tool_use");
  if (!toolUse?.input || typeof toolUse.input !== "object") throw new Error("Claude n'a pas retourné d'extraction structurée.");
  const value = toolUse.input as Record<string, unknown>;
  for (const key of ["client", "contract", "invoice", "fixed_charges", "consumption_lines", "taxes"]) {
    if (!(key in value)) throw new Error(`Extraction incomplète : ${key} est absent.`);
  }
  return value;
}

async function anthropicRequest(path: string, apiKey: string) {
  return fetch(`https://api.anthropic.com${path}`, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "files-api-2025-04-14",
    },
  });
}

async function deleteClaudeFile(fileId: string | null, apiKey: string) {
  if (!fileId) return;
  await fetch(`https://api.anthropic.com/v1/files/${fileId}`, {
    method: "DELETE",
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
  const statusResponse = await anthropicRequest(`/v1/messages/batches/${batch.anthropic_batch_id}`, apiKey);
  if (!statusResponse.ok) {
    const detail = await statusResponse.text();
    await supabase.from("document_batches").update({ last_error: detail.slice(0, 1000), updated_at: new Date().toISOString() }).eq("id", batch.id);
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
  const resultsResponse = await anthropicRequest(`/v1/messages/batches/${batch.anthropic_batch_id}/results`, apiKey);
  if (!resultsResponse.ok) throw new Error(await resultsResponse.text());
  const jsonl = await resultsResponse.text();
  const lines = jsonl.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as BatchLine);

  let succeeded = 0;
  let failed = 0;
  for (const line of lines) {
    const { data: job } = await supabase.from("document_jobs").select("id, anthropic_file_id").eq("id", line.custom_id).maybeSingle();
    if (!job) continue;
    try {
      const extraction = extractionFromResult(line);
      const resultAvailableAt = new Date().toISOString();
      await supabase.from("document_jobs").update({
        status: "needs_review", extraction_json: extraction,
        validation_json: { anthropic_usage: line.result.message?.usage ?? null },
        completed_at: resultAvailableAt, result_available_at: resultAvailableAt,
        updated_at: resultAvailableAt, last_error: null,
      }).eq("id", job.id);
      succeeded++;
    } catch (error) {
      await supabase.from("document_jobs").update({
        status: "failed", last_error: error instanceof Error ? error.message : "Résultat batch invalide", updated_at: new Date().toISOString(),
      }).eq("id", job.id);
      failed++;
    }
    await deleteClaudeFile(job.anthropic_file_id, apiKey).catch(() => null);
    await supabase.from("document_jobs").update({ anthropic_file_id: null, updated_at: new Date().toISOString() }).eq("id", job.id);
  }

  const resultAvailableAt = new Date().toISOString();
  await supabase.from("document_batches").update({
    status: failed === lines.length ? "failed" : "ended",
    request_counts: remoteBatch.request_counts,
    anthropic_ended_at: anthropicEndedAt,
    completed_at: resultAvailableAt,
    result_available_at: resultAvailableAt,
    updated_at: resultAvailableAt,
    last_error: failed ? `${failed} document(s) en erreur` : null,
  }).eq("id", batch.id);

  return { processed: true, batch_id: batch.anthropic_batch_id, succeeded, failed };
}

Deno.serve(async () => {
  const startedAt = Date.now();
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY")!;

  const { data: batches, error: batchError } = await supabase.from("document_batches")
    .select("*").eq("status", "in_progress").order("created_at").limit(10);
  if (batchError) return Response.json({ error: batchError.message }, { status: 500 });
  if (!batches?.length) return Response.json({ processed: false, message: "Aucun batch actif" });

  const results = await Promise.allSettled((batches as BatchRow[]).map((batch) => collectBatch(batch, supabase, apiKey)));
  const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
  return Response.json({
    processed: results.some((result) => result.status === "fulfilled" && result.value.processed),
    checked: batches.length,
    results: results.filter((result) => result.status === "fulfilled").map((result) => result.value),
    errors: failures,
    duration_ms: Date.now() - startedAt,
  }, { status: failures.length === batches.length ? 503 : 200 });
});
