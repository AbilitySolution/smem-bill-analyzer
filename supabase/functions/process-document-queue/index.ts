// Worker du mode `batch` : réserve des jobs, téléverse les fichiers chez le
// fournisseur, puis soumet un lot Message Batches. La classification facture /
// non-facture est rendue par l'extraction elle-même (`document_type`) et lue à la
// collecte — plus d'appel modèle séparé.
//
// Invoqué par le Cron `dispatch-claude-batches` toutes les minutes, et directement par
// le navigateur au dépôt pour ne pas attendre le tick suivant.
//
// La réservation ne ramène jamais que les jobs d'UNE organisation :
//   - Cron       → tourniquet, l'organisation servie le moins récemment ;
//   - navigateur → son organisation, tout de suite.
// Conséquence : aucun lot Anthropic ne mélange les documents de deux clients, et un
// client qui dépose 200 factures ne fait plus attendre celui qui en dépose 2.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { aiRequest, isRetryableProcessingError, releaseRemoteFile, uploadDocument } from "../_shared/ai-client.ts";
import { toUserSafeError } from "../_shared/ai-error.ts";
import { jsonResponse, preflightResponse } from "../_shared/cors.ts";
import { isServiceToken } from "../_shared/service-token.ts";
import { AI_MODEL_OCR, EXTRACTION_PROMPT, SYSTEM_PROMPT, extractionTool } from "../_shared/edf-extraction.ts";

/**
 * Au-delà, un job resté en `uploading_to_claude` est considéré abandonné et repris.
 * Remplace le délai de visibilité de pgmq, retiré du chemin.
 */
const STALE_DISPATCH_SECONDS = 300;
const MAX_ATTEMPTS = 3;
/**
 * Documents visés par lot fournisseur.
 *
 * L'API Batches en accepte des dizaines de milliers ; la vraie contrainte est la
 * **préparation** (un téléchargement + un upload + une classification par document,
 * dans une seule invocation d'Edge Function). Les deux étaient confondus à 5, si bien
 * que 2 000 documents produisaient 400 lots que le collecteur ne pouvait visiter qu'à
 * 10 par minute — 40 minutes rien que pour les regarder. Découplés : la préparation est
 * bornée par `MAX_DOCUMENTS_PER_INVOCATION`, le lot regroupe tout ce qui a été préparé
 * pour une organisation. 2 000 documents → ~20 lots.
 *
 * Alignée sur le plafond dur de `claim_fair_document_jobs`/`claim_org_document_jobs`
 * (`LEAST(job_limit, 100)`, `20260806000002_bigger_batches.sql`) : au-delà, il faudrait
 * relever ce plafond RPC en plus de cette constante.
 */
const TARGET_BATCH_SIZE = 100;
/**
 * Plafond de travail d'une invocation, en documents.
 *
 * Doublé de 50 à 100 avec `FILE_UPLOAD_CONCURRENCY` (3→5) pour rester large sous le
 * timeout d'exécution Supabase (150 s Free / 400 s payant) : à surveiller sur les
 * premières invocations réelles via les logs Edge Function (durée non encore mesurée
 * à ce volume — pas de télémétrie persistée sur cette étape).
 */
const MAX_DOCUMENTS_PER_INVOCATION = 100;
const FILE_UPLOAD_CONCURRENCY = 5;

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

// Les colonnes lues sont stables ; le typage précis vit côté application (lib/types).
// deno-lint-ignore no-explicit-any
type QueuedJobRow = Record<string, any>;

/**
 * Quelle organisation ce passage sert.
 *
 * `fair` : le Cron laisse la base choisir — l'organisation servie le moins récemment
 *          parmi celles qui ont du travail (tourniquet). C'est ce qui empêche un client
 *          déposant 200 factures de bloquer celui qui en dépose 2.
 * `org`  : le navigateur ne sert que SON organisation, immédiatement, sans attendre son
 *          tour ni consommer celui des autres.
 *
 * Dans les deux cas la réservation ne ramène jamais que les jobs d'UNE organisation :
 * un lot Anthropic ne mélange donc jamais les documents de deux clients.
 */
type DispatchScope = { kind: "fair" } | { kind: "org"; orgId: string };

/** Issue de la préparation d'UN document. `failed` reste local au document concerné. */
type PreparedJob = { kind: "prepared"; id: string; mime_type: string; anthropic_file_id: string };
type UploadOutcome =
  | PreparedJob
  | { kind: "failed"; id: string; error: unknown };

/**
 * Réservation.
 *
 * Les deux fonctions font le même contrat, en une seule transaction : sélection
 * `FOR UPDATE SKIP LOCKED`, passage en `uploading_to_claude`, incrément de tentative,
 * et reprise des jobs figés par un worker mort. Il n'y a plus de file de messages à
 * acquitter — `document_jobs` EST la file.
 */
async function claimJobs(
  supabase: ReturnType<typeof createClient>,
  scope: DispatchScope,
  jobLimit: number,
): Promise<QueuedJobRow[] | null> {
  const { data, error } = scope.kind === "org"
    ? await supabase.rpc("claim_org_document_jobs", { requested_org_id: scope.orgId, job_limit: jobLimit })
    : await supabase.rpc("claim_fair_document_jobs", { job_limit: jobLimit, stale_after_seconds: STALE_DISPATCH_SECONDS });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as QueuedJobRow[];
  return rows.length ? rows : null;
}

async function dispatchNextBatch(
  supabase: ReturnType<typeof createClient>,
  aiApiKey: string,
  scope: DispatchScope,
  jobLimit: number,
) {
  const rows = await claimJobs(supabase, scope, jobLimit);
  if (!rows) return null;

  // Toutes les lignes viennent de la même organisation : la réservation le garantit.
  const batchOrgId = rows[0].org_id as string;
  const attemptByJob = new Map<string, number>(rows.map((row) => [row.id as string, (row.attempt_count as number) ?? 1]));
  const prepared: Array<{ id: string; mime_type: string; anthropic_file_id: string }> = [];
  /** Jobs sortis du dispatch pendant ce passage : leur statut ne doit plus être touché. */
  const settled = new Set<string>();
  const dispatchStartedAt = new Date().toISOString();

  try {
    // Préparation isolée par document. Le `try/catch` est DANS le worker, comme dans
    // `process-direct-documents` : sans lui, `Promise.all` remonte la première exception
    // et le `catch` global rétrograde les cinq jobs de la réservation — un seul fichier
    // corrompu faisait passer en `failed`, au bout de trois tentatives, quatre documents
    // parfaitement sains. Les cinq appartiennent désormais au même client, mais le
    // dégât reste inacceptable à l'intérieur d'un client.
    const outcomes = await mapWithConcurrency(rows, FILE_UPLOAD_CONCURRENCY, async (job): Promise<UploadOutcome> => {
      try {
        // `anthropic_file_id` mémorisé : une relance ne réuploade pas le fichier.
        let uploadedFileId = job.anthropic_file_id as string | null;
        if (!uploadedFileId) {
          const { data: file, error: downloadError } = await supabase.storage.from("invoice-files").download(job.file_path);
          if (downloadError || !file) throw new Error(`${job.original_name}: ${downloadError?.message ?? "fichier absent"}`);
          uploadedFileId = await uploadDocument(file, job.original_name, aiApiKey);
          const uploadedAt = new Date().toISOString();
          await supabase.from("document_jobs").update({ anthropic_file_id: uploadedFileId, claude_file_uploaded_at: uploadedAt, updated_at: uploadedAt }).eq("id", job.id);
        }
        // Plus de pré-filtre au dispatch : la classification (`document_type`) est rendue
        // par l'appel d'extraction lui-même et lue par `collect-document-batches` au
        // retour du lot — un seul appel modèle par document, quoi qu'il arrive.
        return { kind: "prepared", id: job.id, mime_type: job.mime_type, anthropic_file_id: uploadedFileId };
      } catch (error) {
        return { kind: "failed", id: job.id, error };
      }
    });

    // Échecs individuels : traités ici, un par un, pour qu'ils ne contaminent personne.
    for (const outcome of outcomes) {
      if (outcome.kind !== "failed") continue;
      settled.add(outcome.id);
      const { userMessage, logMessage } = toUserSafeError(outcome.error);
      console.error(`[process-document-queue] job ${outcome.id} preparation failed:`, logMessage);
      const terminal = (attemptByJob.get(outcome.id) ?? 1) >= MAX_ATTEMPTS || !isRetryableProcessingError(outcome.error);
      await supabase.from("document_jobs")
        .update({ status: terminal ? "failed" : "queued", last_error: userMessage.slice(0, 1000), updated_at: new Date().toISOString() })
        .eq("id", outcome.id)
        .in("status", ["queued", "uploading_to_claude"]);
      // Échec définitif : le fichier distant ne servira plus — un document confidentiel
      // ne doit pas rester chez le fournisseur. Une relance manuelle réuploade.
      if (terminal) await releaseRemoteFile(supabase, outcome.id, aiApiKey);
    }

    const acceptedJobs = outcomes.filter((outcome): outcome is PreparedJob => outcome.kind === "prepared");
    prepared.push(...acceptedJobs.map(({ id, mime_type, anthropic_file_id }) => ({ id, mime_type, anthropic_file_id })));

    if (!prepared.length) return { batchId: null, documentCount: 0, claimedCount: rows.length };
    const batch = await createAiBatch(prepared, aiApiKey);
    const batchCreatedAt = new Date().toISOString();
    const { error: insertError } = await supabase.from("document_batches").insert({
      anthropic_batch_id: batch.id,
      // Un lot = une organisation. Rend la garantie auditable et permet la policy RLS
      // `org_read_document_batches`, donc une estimation de durée par client.
      org_id: batchOrgId,
      status: "in_progress",
      document_count: prepared.length,
      request_counts: batch.request_counts,
      dispatch_started_at: dispatchStartedAt,
      created_at: batchCreatedAt,
    });
    if (insertError) throw new Error(insertError.message);
    await supabase.from("document_jobs").update({ status: "batched", anthropic_batch_id: batch.id, batch_created_at: batchCreatedAt, updated_at: batchCreatedAt, last_error: null })
      .in("id", prepared.map((job) => job.id));
    return { batchId: batch.id, documentCount: prepared.length, claimedCount: rows.length };
  } catch (error) {
    const { userMessage, logMessage } = toUserSafeError(error);
    console.error("[process-document-queue] dispatch error:", logMessage);
    await Promise.all(rows.map(async (job) => {
      // `settled` recense les jobs déjà arrivés à un état définitif pendant CE passage
      // (échec individuel traité plus haut). `rows` porte l'état lu au moment de la
      // réservation : sans cette garde, une erreur survenue APRÈS coup réécrivait un
      // job déjà réglé et effaçait son motif d'origine.
      if (settled.has(job.id) || job.status === "batched") return;
      const terminal = (attemptByJob.get(job.id) ?? 1) >= MAX_ATTEMPTS || !isRetryableProcessingError(error);
      await supabase.from("document_jobs")
        .update({ status: terminal ? "failed" : "queued", last_error: userMessage.slice(0, 1000), updated_at: new Date().toISOString() })
        .eq("id", job.id)
        // Verrou optimiste : seul un job encore en cours de dispatch est rétrogradé.
        .in("status", ["queued", "uploading_to_claude"]);
      if (terminal) await releaseRemoteFile(supabase, job.id, aiApiKey);
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
  let documentsHandled = 0;

  // Découplage des tenants, symétrique de `process-direct-documents` : un appel de
  // service (Cron) sert les organisations en tourniquet, un appel utilisateur est borné
  // à SON organisation. Sans ça, n'importe quel utilisateur authentifié déclenchait — et
  // pouvait faire échouer — le dispatch des documents des autres organisations.
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  let scope: DispatchScope = { kind: "fair" };
  if (token && !isServiceToken(token, serviceRoleKey)) {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    const { data: role } = await supabase
      .from("user_roles").select("org_id").eq("user_id", data.user.id).maybeSingle();
    const orgId = (role as { org_id?: string } | null)?.org_id;
    // Provisioning incomplet : pas d'organisation, donc aucun périmètre légitime. On
    // refuse plutôt que de retomber sur le tourniquet, qui sert tout le monde.
    if (!orgId) return jsonResponse({ error: "Forbidden" }, { status: 403 });
    scope = { kind: "org", orgId };
  }

  try {
    // Bornée par les documents traités, pas par le nombre de lots : une organisation qui
    // a 200 documents en attente consomme tout le budget en UN lot, tandis que dix
    // organisations avec 5 documents chacune sont toutes servies dans la même invocation.
    while (documentsHandled < MAX_DOCUMENTS_PER_INVOCATION) {
      const budget = Math.min(TARGET_BATCH_SIZE, MAX_DOCUMENTS_PER_INVOCATION - documentsHandled);
      const result = await dispatchNextBatch(supabase, aiApiKey, scope, budget);
      if (!result) break;
      documentsHandled += result.claimedCount;
      if (result.documentCount > 0) batches.push({ batchId: result.batchId, documentCount: result.documentCount });
    }
    return jsonResponse({
      processed: batches.length > 0,
      scope: scope.kind,
      batches,
      batch_count: batches.length,
      document_count: batches.reduce((total, batch) => total + batch.documentCount, 0),
      documents_handled: documentsHandled,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error) {
    const { userMessage, logMessage } = toUserSafeError(error);
    console.error("[process-document-queue] invocation error:", logMessage);
    return jsonResponse({ processed: false, batches, error: userMessage }, { status: 503 });
  }
});
