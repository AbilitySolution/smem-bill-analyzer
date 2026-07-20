import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const QUEUE_VISIBILITY_SECONDS = 180;
const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 5;
const MAX_BATCHES_PER_INVOCATION = 10;
const FILE_UPLOAD_CONCURRENCY = 3;
const OCR_MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `Tu es un assistant spécialisé dans l'extraction de données de factures EDF (électricité) pour des bâtiments publics et points d'éclairage public en France.

Règles générales :
- Toutes les dates au format ISO 8601 (YYYY-MM-DD).
- Les montants en nombre décimal avec point comme séparateur, sans symbole €.
- Si une valeur est absente ou illisible : null — ne jamais inventer.
- Codes poste_tarifaire canoniques : HP, HC, BASE, HPB, HCB, HPW, HCW, HPR, HCR, EJPN, EJPP.
- Sur contrat HPHC, HP est toujours plus cher que HC. Relis la facture si les deux prix sont identiques.
- precision : score 0-1 pour chaque champ clé.`;

const EXTRACTION_PROMPT = `Extrait toutes les données structurées de cette facture EDF avec l'outil extract_edf_invoice.
- fixed_charges : part fixe et abonnements.
- consumption_lines : période courante uniquement, jamais l'historique.
- taxes : une ligne par taxe et période.
- Une consommation sans HP/HC utilise BASE.
- tarif_type vaut BASE, HPHC, TEMPO, EJP ou null.
- is_duplicata vaut true si DUPLICATA apparaît.
- commune_hint reprend le nom visible sans l'inventer.
- categorie_hint vaut batiment, eclairage_public ou null.`;

const nullableString = { type: ["string", "null"] };
const nullableNumber = { type: ["number", "null"] };

const extractionTool = {
  name: "extract_edf_invoice",
  description: "Extrait les données structurées d'une facture EDF.",
  input_schema: {
    type: "object",
    properties: {
      client: {
        type: "object",
        properties: {
          nom: { type: "string" },
          reference_client: nullableString,
          reference_compte: nullableString,
          adresse: nullableString,
        },
        required: ["nom", "reference_client", "reference_compte", "adresse"],
      },
      contract: {
        type: "object",
        properties: {
          contract_number: { type: "string" },
          tarif_type: { ...nullableString, enum: ["BASE", "HPHC", "TEMPO", "EJP", null] },
          espace_livraison: nullableString,
          offre: nullableString,
          service: nullableString,
          puissance_souscrite_kva: nullableNumber,
          reglage_protection_a: nullableNumber,
          type_compteur: nullableString,
          numero_compteur: nullableString,
        },
        required: ["contract_number", "tarif_type", "espace_livraison", "offre", "service", "puissance_souscrite_kva", "reglage_protection_a", "type_compteur", "numero_compteur"],
      },
      invoice: {
        type: "object",
        properties: {
          facture_number: { type: "string" },
          facture_date: { type: "string" },
          date_limite_paiement: nullableString,
          date_prochain_releve: nullableString,
          date_prochaine_facture: nullableString,
          total_ht: { type: "number" },
          tva: nullableNumber,
          autres_taxes: nullableNumber,
          total_ttc: { type: "number" },
          is_duplicata: { type: "boolean" },
        },
        required: ["facture_number", "facture_date", "date_limite_paiement", "date_prochain_releve", "date_prochaine_facture", "total_ht", "tva", "autres_taxes", "total_ttc", "is_duplicata"],
      },
      commune_hint: nullableString,
      categorie_hint: { ...nullableString, enum: ["batiment", "eclairage_public", null] },
      fixed_charges: {
        type: "array",
        items: {
          type: "object",
          properties: { libelle: { type: "string" }, date_debut: nullableString, date_fin: nullableString, tarif_kva_an: nullableNumber, montant_eur: { type: "number" } },
          required: ["libelle", "date_debut", "date_fin", "tarif_kva_an", "montant_eur"],
        },
      },
      consumption_lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            poste_tarifaire: { type: "string" }, date_debut: nullableString, date_fin: nullableString,
            numero_compteur: nullableString, ancien_index: nullableNumber, nouveau_index: nullableNumber,
            coefficient: { type: "number" }, consommation_kwh: { type: "number" }, prix_unitaire_ckwh: nullableNumber,
            montant_eur: { type: "number" }, index_estime: { type: "boolean" },
          },
          required: ["poste_tarifaire", "date_debut", "date_fin", "numero_compteur", "ancien_index", "nouveau_index", "coefficient", "consommation_kwh", "prix_unitaire_ckwh", "montant_eur", "index_estime"],
        },
      },
      taxes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            libelle: { type: "string" }, date_debut: nullableString, date_fin: nullableString,
            assiette: nullableNumber, taux: nullableString, taux_numeric: nullableNumber,
            taux_unit: { ...nullableString, enum: ["eur_per_kwh", "percent", null] }, montant_eur: { type: "number" },
          },
          required: ["libelle", "date_debut", "date_fin", "assiette", "taux", "taux_numeric", "taux_unit", "montant_eur"],
        },
      },
      precision: {
        type: "object",
        properties: {
          facture_number: { type: "number" }, facture_date: { type: "number" }, total_ht: { type: "number" },
          tva: { type: "number" }, autres_taxes: { type: "number" }, total_ttc: { type: "number" },
          contract_number: { type: "number" }, puissance_souscrite_kva: { type: "number" },
        },
        required: ["facture_number", "facture_date", "total_ht", "tva", "autres_taxes", "total_ttc", "contract_number", "puissance_souscrite_kva"],
      },
    },
    required: ["client", "contract", "invoice", "commune_hint", "categorie_hint", "fixed_charges", "consumption_lines", "taxes", "precision"],
  },
};

function claudeSafeFilename(filename: string) {
  const basename = filename.split(/[\\/]/).pop()?.trim() || "document";
  const sanitized = Array.from(basename.normalize("NFKC"))
    .map((character) => /[<>:"|?*\\/\u0000-\u001F]/.test(character) ? "_" : character)
    .join("")
    .trim();

  const safe = sanitized || "document";
  const characters = Array.from(safe);
  if (characters.length <= 200) return safe;

  // Anthropic accepts 1–255 characters. Keep the extension while leaving a
  // margin for Unicode filenames and multipart encoding details.
  const extensionIndex = safe.lastIndexOf(".");
  const extension = extensionIndex > 0 ? safe.slice(extensionIndex, extensionIndex + 16) : "";
  return `${characters.slice(0, 200 - Array.from(extension).length).join("")}${extension}`;
}

async function uploadToClaude(file: Blob, filename: string, apiKey: string) {
  const formData = new FormData();
  formData.append("file", file, claudeSafeFilename(filename));
  const response = await fetch("https://api.anthropic.com/v1/files", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "files-api-2025-04-14",
    },
    body: formData,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Claude Files ${response.status}: ${detail.slice(0, 500)}`);
  }
  return await response.json() as { id: string };
}

async function createClaudeBatch(
  jobs: Array<{ id: string; mime_type: string; anthropic_file_id: string }>,
  apiKey: string,
) {
  const requests = jobs.map((job) => {
    const blockType = job.mime_type === "application/pdf" ? "document" : "image";
    return {
      custom_id: job.id,
      params: {
        model: OCR_MODEL,
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

  const response = await fetch("https://api.anthropic.com/v1/messages/batches", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "files-api-2025-04-14",
    },
    body: JSON.stringify({ requests }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Claude Batch ${response.status}: ${detail.slice(0, 800)}`);
  }
  return await response.json() as { id: string; processing_status: string; request_counts: Record<string, number> };
}

function isRetryableProcessingError(error: unknown) {
  if (!(error instanceof Error)) return true;
  const status = error.message.match(/(?:Claude Files|Claude Batch)\s+(\d{3}):/)?.[1];
  if (!status) return true;
  return ["408", "409", "429", "500", "502", "503", "504", "529"].includes(status);
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

async function dispatchNextBatch(
  supabase: ReturnType<typeof createClient>,
  anthropicKey: string,
) {
  const { data: claims, error: claimError } = await supabase.rpc("claim_document_jobs", {
    visibility_timeout_seconds: QUEUE_VISIBILITY_SECONDS,
    message_limit: BATCH_SIZE,
  });
  if (claimError) throw new Error(claimError.message);
  if (!claims?.length) return null;

  const claimByJob = new Map(claims.map((claim: { job_id: string; message_id: number }) => [claim.job_id, claim]));
  const { data: rows, error: jobsError } = await supabase.from("document_jobs").select("*").in("id", claims.map((claim: { job_id: string }) => claim.job_id));
  if (jobsError) throw new Error(jobsError.message);
  const prepared: Array<{ id: string; mime_type: string; anthropic_file_id: string }> = [];
  const dispatchStartedAt = new Date().toISOString();

  try {
    const candidates = [];
    for (const job of rows ?? []) {
      if (["batched", "needs_review", "completed"].includes(job.status)) {
        await supabase.rpc("acknowledge_document_job", { message_id: claimByJob.get(job.id)?.message_id });
        continue;
      }
      const attempt = (job.attempt_count ?? 0) + 1;
      await supabase.from("document_jobs").update({ status: "uploading_to_claude", attempt_count: attempt, dispatch_started_at: dispatchStartedAt, started_at: dispatchStartedAt, updated_at: dispatchStartedAt }).eq("id", job.id);
      candidates.push(job);
    }

    const uploaded = await mapWithConcurrency(candidates, FILE_UPLOAD_CONCURRENCY, async (job) => {
      let fileId = job.anthropic_file_id as string | null;
      if (!fileId) {
        const { data: file, error: downloadError } = await supabase.storage.from("invoice-files").download(job.file_path);
        if (downloadError || !file) throw new Error(`${job.original_name}: ${downloadError?.message ?? "fichier absent"}`);
        fileId = (await uploadToClaude(file, job.original_name, anthropicKey)).id;
        const uploadedAt = new Date().toISOString();
        await supabase.from("document_jobs").update({ anthropic_file_id: fileId, claude_file_uploaded_at: uploadedAt, updated_at: uploadedAt }).eq("id", job.id);
      }
      return { id: job.id, mime_type: job.mime_type, anthropic_file_id: fileId };
    });
    prepared.push(...uploaded);

    if (!prepared.length) return { batchId: null, documentCount: 0 };
    const batch = await createClaudeBatch(prepared, anthropicKey);
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
    const message = error instanceof Error ? error.message : "Erreur OCR inconnue";
    await Promise.all((rows ?? []).map(async (job) => {
      if (job.status === "batched") return;
      const terminal = (job.attempt_count ?? 0) + 1 >= MAX_ATTEMPTS || !isRetryableProcessingError(error);
      await supabase.from("document_jobs").update({ status: terminal ? "failed" : "queued", last_error: message.slice(0, 1000), updated_at: new Date().toISOString() }).eq("id", job.id);
      if (terminal) await supabase.rpc("acknowledge_document_job", { message_id: claimByJob.get(job.id)?.message_id });
    }));
    throw error;
  }
}

Deno.serve(async () => {
  const startedAt = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;
  const batches: Array<{ batchId: string | null; documentCount: number }> = [];

  try {
    for (let index = 0; index < MAX_BATCHES_PER_INVOCATION; index++) {
      const result = await dispatchNextBatch(supabase, anthropicKey);
      if (!result) break;
      if (result.documentCount > 0) batches.push(result);
    }
    return Response.json({
      processed: batches.length > 0,
      batches,
      batch_count: batches.length,
      document_count: batches.reduce((total, batch) => total + batch.documentCount, 0),
      duration_ms: Date.now() - startedAt,
    });
  } catch (error) {
    return Response.json({ processed: false, batches, error: error instanceof Error ? error.message : "Erreur OCR inconnue" }, { status: 503 });
  }
});
