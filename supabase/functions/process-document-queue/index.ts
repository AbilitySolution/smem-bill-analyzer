// Worker du mode `batch` : réserve des jobs dans pgmq, téléverse les fichiers chez le
// fournisseur, pré-filtre, puis soumet un lot Message Batches.
//
// Invoqué par le Cron `dispatch-claude-batches` toutes les minutes, et directement par
// le navigateur au dépôt pour ne pas attendre le tick suivant.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { aiRequest, deleteDocument, isRetryableProcessingError, uploadDocument, classifyDocument } from "../_shared/ai-client.ts";
import { toUserSafeError } from "../_shared/ai-error.ts";
import { jsonResponse, preflightResponse } from "../_shared/cors.ts";
import { AI_MODEL_OCR, EXTRACTION_PROMPT, SYSTEM_PROMPT, extractionTool } from "../_shared/edf-extraction.ts";

const QUEUE_VISIBILITY_SECONDS = 180;
const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 5;
const MAX_BATCHES_PER_INVOCATION = 10;
const FILE_UPLOAD_CONCURRENCY = 3;

async function createAiBatch(
  jobs: Array<{ id: string; mime_type: string; anthropic_file_id: string }>,
  apiKey: string,
) {
  const requests = jobs.map((job) => {
    const blockType = job.mime_type === "application/pdf" ? "document" : "image";
    return {
      // `custom_id` = document_jobs.id : la seule clé qui relie une réponse du lot à sa
      // ligne en base, les résultats revenant dans un ordre quelconque.
      custom_id: job.id,
      params: {
        model: AI_MODEL_OCR,
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        tools: [extractionTool],
        tool_choice: { type: "tool", name: "extract_edf_invoice" },
        messages: [{
          role: "user",
          content: [
            { type: blockType, source: { type: "file", file_id: job.anthropic_file_id } },
            { type: "text", text: EXTRACTION_PROMPT },
          ],
        }],
      },
    };
  });

  const response = await aiRequest("/v1/messages/batches", apiKey, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  return await response.json() as { id: string; processing_status: string; request_counts: Record<string, number> };
}

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

type QueueClaim = { message_id: number; job_id: string; read_count: number };
// Les colonnes lues sont stables ; le typage précis vit côté application (lib/types).
// deno-lint-ignore no-explicit-any
type QueuedJobRow = Record<string, any>;

async function dispatchNextBatch(
  supabase: ReturnType<typeof createClient>,
  aiApiKey: string,
) {
  const { data, error: claimError } = await supabase.rpc("claim_document_jobs", {
    visibility_timeout_seconds: QUEUE_VISIBILITY_SECONDS,
    message_limit: BATCH_SIZE,
  });
  if (claimError) throw new Error(claimError.message);
  const claims = (data ?? []) as QueueClaim[];
  if (!claims.length) return null;

  const claimByJob = new Map<string, QueueClaim>(claims.map((claim) => [claim.job_id, claim]));
  const { data: jobRows, error: jobsError } = await supabase.from("document_jobs").select("*").in("id", claims.map((claim) => claim.job_id));
  if (jobsError) throw new Error(jobsError.message);
  const rows = (jobRows ?? []) as QueuedJobRow[];
  const prepared: Array<{ id: string; mime_type: string; anthropic_file_id: string }> = [];
  const dispatchStartedAt = new Date().toISOString();

  try {
    const candidates: QueuedJobRow[] = [];
    for (const job of rows) {
      // Garde anti-double-traitement : un message rejoué pour un job déjà parti est
      // acquitté et ignoré.
      if (["batched", "needs_review", "completed"].includes(job.status)) {
        await supabase.rpc("acknowledge_document_job", { message_id: claimByJob.get(job.id)?.message_id });
        continue;
      }
      const attempt = (job.attempt_count ?? 0) + 1;
      await supabase.from("document_jobs").update({ status: "uploading_to_claude", attempt_count: attempt, dispatch_started_at: dispatchStartedAt, started_at: dispatchStartedAt, updated_at: dispatchStartedAt }).eq("id", job.id);
      candidates.push(job);
    }

    const uploaded = await mapWithConcurrency(candidates, FILE_UPLOAD_CONCURRENCY, async (job) => {
      // `anthropic_file_id` mémorisé : une relance ne réuploade pas le fichier.
      let fileId = job.anthropic_file_id as string | null;
      if (!fileId) {
        const { data: file, error: downloadError } = await supabase.storage.from("invoice-files").download(job.file_path);
        if (downloadError || !file) throw new Error(`${job.original_name}: ${downloadError?.message ?? "fichier absent"}`);
        fileId = await uploadDocument(file, job.original_name, aiApiKey);
        const uploadedAt = new Date().toISOString();
        await supabase.from("document_jobs").update({ anthropic_file_id: fileId, claude_file_uploaded_at: uploadedAt, updated_at: uploadedAt }).eq("id", job.id);
      }

      if (!job.skip_prefilter) {
        try {
          const classification = await classifyDocument(fileId, job.mime_type, aiApiKey);
          if (!classification.isInvoice) {
            const now = new Date().toISOString();
            await supabase.from("document_jobs").update({
              status: "rejected_non_invoice",
              prefilter_type: classification.type,
              completed_at: now,
              result_available_at: now,
              updated_at: now,
              last_error: null,
            }).eq("id", job.id);
            await deleteDocument(fileId, aiApiKey);
            await supabase.from("document_jobs").update({ anthropic_file_id: null, updated_at: new Date().toISOString() }).eq("id", job.id);
            return { id: job.id, rejected: true as const };
          }
        } catch {
          // Classifieur indisponible ou réponse invalide : on ne bloque pas le lot,
          // le document part en extraction normale (biais volontaire vers l'acceptation).
        }
      }

      return { id: job.id, mime_type: job.mime_type, anthropic_file_id: fileId, rejected: false as const };
    });
    const rejectedJobs = uploaded.filter((job) => job.rejected);
    const acceptedJobs = uploaded.filter((job): job is { id: string; mime_type: string; anthropic_file_id: string; rejected: false } => !job.rejected);
    await Promise.all(rejectedJobs.map((job) => supabase.rpc("acknowledge_document_job", { message_id: claimByJob.get(job.id)?.message_id })));
    prepared.push(...acceptedJobs);

    if (!prepared.length) return { batchId: null, documentCount: 0 };
    const batch = await createAiBatch(prepared, aiApiKey);
    const batchCreatedAt = new Date().toISOString();
    const { error: insertError } = await supabase.from("document_batches").insert({
      anthropic_batch_id: batch.id,
      status: "in_progress",
      document_count: prepared.length,
      request_counts: batch.request_counts,
      dispatch_started_at: dispatchStartedAt,
      created_at: batchCreatedAt,
    });
    if (insertError) throw new Error(insertError.message);
    await supabase.from("document_jobs").update({ status: "batched", anthropic_batch_id: batch.id, batch_created_at: batchCreatedAt, updated_at: batchCreatedAt, last_error: null })
      .in("id", prepared.map((job) => job.id));
    await Promise.all(prepared.map((job) => supabase.rpc("acknowledge_document_job", { message_id: claimByJob.get(job.id)?.message_id })));
    return { batchId: batch.id, documentCount: prepared.length };
  } catch (error) {
    const { userMessage, logMessage } = toUserSafeError(error);
    console.error("[process-document-queue] dispatch error:", logMessage);
    await Promise.all(rows.map(async (job) => {
      if (job.status === "batched") return;
      const terminal = (job.attempt_count ?? 0) + 1 >= MAX_ATTEMPTS || !isRetryableProcessingError(error);
      await supabase.from("document_jobs").update({ status: terminal ? "failed" : "queued", last_error: userMessage.slice(0, 1000), updated_at: new Date().toISOString() }).eq("id", job.id);
      // Sur erreur terminale, acquitter : sinon le message est rejoué indéfiniment.
      if (terminal) await supabase.rpc("acknowledge_document_job", { message_id: claimByJob.get(job.id)?.message_id });
    }));
    throw error;
  }
}

Deno.serve(async (request) => {
  const preflight = preflightResponse(request);
  if (preflight) return preflight;

  const startedAt = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const aiApiKey = Deno.env.get("ANTHROPIC_API_KEY")!;
  const batches: Array<{ batchId: string | null; documentCount: number }> = [];

  try {
    for (let index = 0; index < MAX_BATCHES_PER_INVOCATION; index++) {
      const result = await dispatchNextBatch(supabase, aiApiKey);
      if (!result) break;
      if (result.documentCount > 0) batches.push(result);
    }
    return jsonResponse({
      processed: batches.length > 0,
      batches,
      batch_count: batches.length,
      document_count: batches.reduce((total, batch) => total + batch.documentCount, 0),
      duration_ms: Date.now() - startedAt,
    });
  } catch (error) {
    const { userMessage, logMessage } = toUserSafeError(error);
    console.error("[process-document-queue] invocation error:", logMessage);
    return jsonResponse({ processed: false, batches, error: userMessage }, { status: 503 });
  }
});
