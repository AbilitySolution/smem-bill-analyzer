// Worker du mode `direct` : extraction synchrone, quelques secondes par document.
//
// Deux appelants :
//   - le Cron `process-direct-documents` (Bearer service_role) → traite tous les jobs
//     en attente, `ownerId = null` ;
//   - le navigateur au dépôt (jeton utilisateur) → `ownerId` renseigné, la réservation
//     est alors filtrée sur `created_by`. Permet de démarrer sans attendre le tick.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { aiRequest, classifyDocument, isRetryableProcessingError, releaseRemoteFile, uploadDocument } from "../_shared/ai-client.ts";
import { toUserSafeError } from "../_shared/ai-error.ts";
import { jsonResponse, preflightResponse } from "../_shared/cors.ts";
import { isServiceToken } from "../_shared/service-token.ts";
import { AI_MODEL_OCR, EXTRACTION_PROMPT, SYSTEM_PROMPT, extractionTool } from "../_shared/edf-extraction.ts";

const MAX_JOBS = 10;
const CONCURRENCY = 3;
const MAX_ATTEMPTS = 3;

type DocumentJob = {
  id: string;
  file_path: string;
  original_name: string;
  mime_type: string;
  attempt_count: number;
  anthropic_file_id: string | null;
  skip_prefilter: boolean;
};

type ExtractionOutcome =
  | { kind: "rejected"; type: string; fileId: string }
  | { kind: "extracted"; extraction: unknown; usage: Record<string, number> | null; fileId: string };

async function extractInvoice(job: DocumentJob, supabase: ReturnType<typeof createClient>, apiKey: string): Promise<ExtractionOutcome> {
  let uploadedFileId = job.anthropic_file_id;
  if (!uploadedFileId) {
    const { data: file, error } = await supabase.storage.from("invoice-files").download(job.file_path);
    if (error || !file) throw new Error(error?.message ?? "Fichier absent de Supabase Storage");
    uploadedFileId = await uploadDocument(file, job.original_name, apiKey);
    await supabase.from("document_jobs").update({ anthropic_file_id: uploadedFileId, claude_file_uploaded_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", job.id);
  }
  // Figé dans un `const` : le `try/catch` du pré-filtre ci-dessous fait perdre à
  // TypeScript le rétrécissement d'un `let`, et `fileId` repassait `string | null` alors
  // qu'il est garanti non nul ici. `ExtractionOutcome` le déclare `string`.
  const fileId = uploadedFileId;

  if (!job.skip_prefilter) {
    try {
      const classification = await classifyDocument(fileId, job.mime_type, apiKey);
      if (!classification.isInvoice) return { kind: "rejected", type: classification.type, fileId };
    } catch {
      // Classifieur indisponible ou réponse invalide : on ne bloque pas le document,
      // il part en extraction normale (biais volontaire vers l'acceptation).
    }
  }

  const blockType = job.mime_type === "application/pdf" ? "document" : "image";
  const response = await aiRequest("/v1/messages", apiKey, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: AI_MODEL_OCR,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools: [extractionTool],
      tool_choice: { type: "tool", name: "extract_edf_invoice" },
      messages: [{
        role: "user",
        content: [
          { type: blockType, source: { type: "file", file_id: fileId } },
          { type: "text", text: EXTRACTION_PROMPT },
        ],
      }],
    }),
  });
  const message = await response.json() as { content?: Array<{ type: string; input?: unknown }>; usage?: Record<string, number> };
  const toolUse = message.content?.find((block) => block.type === "tool_use");
  if (!toolUse?.input || typeof toolUse.input !== "object") throw new Error("L'extraction structurée n'a pas été retournée");
  return { kind: "extracted", extraction: toolUse.input, usage: message.usage ?? null, fileId };
}

async function mapWithConcurrency<T>(values: T[], limit: number, worker: (value: T) => Promise<void>) {
  let nextIndex = 0;
  async function run() {
    while (nextIndex < values.length) {
      const value = values[nextIndex++];
      await worker(value);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => run()));
}

Deno.serve(async (request) => {
  const preflight = preflightResponse(request);
  if (preflight) return preflight;

  const startedAt = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  // Appel de service (Cron) → `ownerId` nul, tous les jobs en attente sont traités.
  // Appel utilisateur → réservation restreinte à ses propres dépôts.
  let ownerId: string | null = null;
  if (token && !isServiceToken(token, serviceRoleKey)) {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    ownerId = data.user.id;
  }

  const body = await request.json().catch(() => ({})) as { job_ids?: unknown };
  const requestedIds = Array.isArray(body.job_ids)
    ? body.job_ids.filter((id): id is string => typeof id === "string").slice(0, MAX_JOBS)
    : null;
  const { data: jobs, error: claimError } = await supabase.rpc("claim_direct_document_jobs", {
    requested_job_ids: requestedIds?.length ? requestedIds : null,
    requested_owner_id: ownerId,
    job_limit: MAX_JOBS,
  });
  if (claimError) return jsonResponse({ error: claimError.message }, { status: 500 });
  if (!jobs?.length) return jsonResponse({ processed: false, message: "Aucun job direct en attente" });

  let succeeded = 0;
  let failed = 0;
  await mapWithConcurrency(jobs as DocumentJob[], CONCURRENCY, async (job) => {
    try {
      const result = await extractInvoice(job, supabase, apiKey);
      const now = new Date().toISOString();
      // Toutes les écritures finales sont conditionnées par `.eq("status", "direct_processing")` :
      // verrouillage optimiste, un job relancé entre-temps n'est pas écrasé.
      if (result.kind === "rejected") {
        await supabase.from("document_jobs").update({
          status: "rejected_non_invoice",
          prefilter_type: result.type,
          completed_at: now,
          result_available_at: now,
          updated_at: now,
          last_error: null,
        }).eq("id", job.id).eq("status", "direct_processing");
      } else {
        await supabase.from("document_jobs").update({
          status: "needs_review",
          extraction_json: result.extraction,
          validation_json: { anthropic_usage: result.usage },
          completed_at: now,
          result_available_at: now,
          updated_at: now,
          last_error: null,
        }).eq("id", job.id).eq("status", "direct_processing");
      }
      await releaseRemoteFile(supabase, job.id, apiKey);
      succeeded++;
    } catch (error) {
      const { userMessage, logMessage } = toUserSafeError(error);
      console.error(`[process-direct-documents] job ${job.id} failed:`, logMessage);
      const terminal = job.attempt_count >= MAX_ATTEMPTS || !isRetryableProcessingError(error);
      await supabase.from("document_jobs").update({
        status: terminal ? "failed" : "direct_queued",
        last_error: userMessage.slice(0, 1000),
        updated_at: new Date().toISOString(),
      }).eq("id", job.id).eq("status", "direct_processing");
      // Échec définitif : ne pas laisser le document confidentiel chez le fournisseur.
      if (terminal) await releaseRemoteFile(supabase, job.id, apiKey);
      failed++;
    }
  });

  return jsonResponse({
    processed: true,
    mode: "direct",
    claimed: jobs.length,
    succeeded,
    failed,
    duration_ms: Date.now() - startedAt,
  });
});
