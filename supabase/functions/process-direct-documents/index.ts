import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const MAX_JOBS = 10;
const CONCURRENCY = 3;
const MAX_ATTEMPTS = 3;
const OCR_MODEL = "claude-sonnet-4-6";
const PREFILTER_MODEL = "claude-haiku-4-5";

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

const CLASSIFY_SYSTEM_PROMPT = "Tu vérifies si un document est une facture d'électricité individuelle avant son traitement. Réponds uniquement avec l'outil classify_document.";

const CLASSIFY_PROMPT = "Ce document est-il UNE facture d'électricité individuelle (un numéro de facture, un montant à payer pour un seul contrat) ? Ce n'est PAS une facture s'il s'agit d'un bordereau récapitulatif (liste de plusieurs factures dans un tableau), d'un courrier, d'un justificatif ou de tout autre document. En cas de doute, réponds true. Utilise l'outil classify_document.";

const classifyTool = {
  name: "classify_document",
  description: "Détermine si le document est une facture d'électricité individuelle avant extraction complète.",
  input_schema: {
    type: "object",
    properties: {
      is_facture_electricite: { type: "boolean" },
      type_document: { type: "string", enum: ["facture", "bordereau_recapitulatif", "autre"] },
    },
    required: ["is_facture_electricite", "type_document"],
  },
};

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
        properties: { nom: { type: "string" }, reference_client: nullableString, reference_compte: nullableString, adresse: nullableString },
        required: ["nom", "reference_client", "reference_compte", "adresse"],
      },
      contract: {
        type: "object",
        properties: {
          contract_number: { type: "string" }, tarif_type: { ...nullableString, enum: ["BASE", "HPHC", "TEMPO", "EJP", null] },
          espace_livraison: nullableString, offre: nullableString, service: nullableString,
          puissance_souscrite_kva: nullableNumber, reglage_protection_a: nullableNumber,
          type_compteur: nullableString, numero_compteur: nullableString,
        },
        required: ["contract_number", "tarif_type", "espace_livraison", "offre", "service", "puissance_souscrite_kva", "reglage_protection_a", "type_compteur", "numero_compteur"],
      },
      invoice: {
        type: "object",
        properties: {
          facture_number: { type: "string" }, facture_date: { type: "string" }, date_limite_paiement: nullableString,
          date_prochain_releve: nullableString, date_prochaine_facture: nullableString, total_ht: { type: "number" },
          tva: nullableNumber, autres_taxes: nullableNumber, total_ttc: { type: "number" }, is_duplicata: { type: "boolean" },
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
          properties: { libelle: { type: "string" }, date_debut: nullableString, date_fin: nullableString, assiette: nullableNumber, taux: nullableString, taux_numeric: nullableNumber, taux_unit: { ...nullableString, enum: ["eur_per_kwh", "percent", null] }, montant_eur: { type: "number" } },
          required: ["libelle", "date_debut", "date_fin", "assiette", "taux", "taux_numeric", "taux_unit", "montant_eur"],
        },
      },
      precision: {
        type: "object",
        properties: { facture_number: { type: "number" }, facture_date: { type: "number" }, total_ht: { type: "number" }, tva: { type: "number" }, autres_taxes: { type: "number" }, total_ttc: { type: "number" }, contract_number: { type: "number" }, puissance_souscrite_kva: { type: "number" } },
        required: ["facture_number", "facture_date", "total_ht", "tva", "autres_taxes", "total_ttc", "contract_number", "puissance_souscrite_kva"],
      },
    },
    required: ["client", "contract", "invoice", "commune_hint", "categorie_hint", "fixed_charges", "consumption_lines", "taxes", "precision"],
  },
};

type DocumentJob = {
  id: string;
  file_path: string;
  original_name: string;
  mime_type: string;
  attempt_count: number;
  anthropic_file_id: string | null;
  skip_prefilter: boolean;
};

function safeFilename(filename: string) {
  const basename = filename.split(/[\\/]/).pop()?.trim() || "document";
  return Array.from(basename.normalize("NFKC"))
    .map((character) => /[<>:"|?*\\/\u0000-\u001F]/.test(character) ? "_" : character)
    .join("").trim().slice(0, 200) || "document";
}

async function anthropicFetch(path: string, apiKey: string, init: RequestInit) {
  let lastError = "Anthropic request failed";
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`https://api.anthropic.com${path}`, {
      ...init,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "files-api-2025-04-14",
        ...init.headers,
      },
    });
    if (response.ok) return response;
    lastError = `${response.status}: ${(await response.text()).slice(0, 800)}`;
    if (![429, 529].includes(response.status) || attempt === 2) break;
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1000 : 3000));
  }
  throw new Error(lastError);
}

function isRetryableProcessingError(error: unknown) {
  if (!(error instanceof Error)) return true;
  const status = error.message.match(/^(\d{3}):/)?.[1];
  if (!status) return true;
  return ["408", "409", "429", "500", "502", "503", "504", "529"].includes(status);
}

async function uploadToClaude(file: Blob, filename: string, apiKey: string) {
  const formData = new FormData();
  formData.append("file", file, safeFilename(filename));
  const response = await anthropicFetch("/v1/files", apiKey, { method: "POST", body: formData });
  return (await response.json() as { id: string }).id;
}

async function classifyDocument(fileId: string, mimeType: string, apiKey: string) {
  const blockType = mimeType === "application/pdf" ? "document" : "image";
  const response = await anthropicFetch("/v1/messages", apiKey, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: PREFILTER_MODEL,
      max_tokens: 60,
      system: CLASSIFY_SYSTEM_PROMPT,
      tools: [classifyTool],
      tool_choice: { type: "tool", name: "classify_document" },
      messages: [{ role: "user", content: [
        { type: blockType, source: { type: "file", file_id: fileId } },
        { type: "text", text: CLASSIFY_PROMPT },
      ] }],
    }),
  });
  const message = await response.json() as { content?: Array<{ type: string; input?: unknown }> };
  const toolUse = message.content?.find((block) => block.type === "tool_use");
  const input = toolUse?.input as { is_facture_electricite?: unknown; type_document?: unknown } | undefined;
  if (!input || typeof input.is_facture_electricite !== "boolean") throw new Error("Classification invalide");
  return { isInvoice: input.is_facture_electricite, type: typeof input.type_document === "string" ? input.type_document : "autre" };
}

type ExtractionOutcome =
  | { kind: "rejected"; type: string; fileId: string }
  | { kind: "extracted"; extraction: unknown; usage: Record<string, number> | null; fileId: string };

async function extractInvoice(job: DocumentJob, supabase: ReturnType<typeof createClient>, apiKey: string): Promise<ExtractionOutcome> {
  let fileId = job.anthropic_file_id;
  if (!fileId) {
    const { data: file, error } = await supabase.storage.from("invoice-files").download(job.file_path);
    if (error || !file) throw new Error(error?.message ?? "Fichier absent de Supabase Storage");
    fileId = await uploadToClaude(file, job.original_name, apiKey);
    await supabase.from("document_jobs").update({ anthropic_file_id: fileId, claude_file_uploaded_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", job.id);
  }

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
  const response = await anthropicFetch("/v1/messages", apiKey, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: OCR_MODEL,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools: [extractionTool],
      tool_choice: { type: "tool", name: "extract_edf_invoice" },
      messages: [{ role: "user", content: [
        { type: blockType, source: { type: "file", file_id: fileId } },
        { type: "text", text: EXTRACTION_PROMPT },
      ] }],
    }),
  });
  const message = await response.json() as { content?: Array<{ type: string; input?: unknown }>; usage?: Record<string, number> };
  const toolUse = message.content?.find((block) => block.type === "tool_use");
  if (!toolUse?.input || typeof toolUse.input !== "object") throw new Error("Claude n'a pas retourné d'extraction structurée");
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
  const startedAt = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  let ownerId: string | null = null;
  if (token && token !== serviceRoleKey) {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
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
  if (claimError) return Response.json({ error: claimError.message }, { status: 500 });
  if (!jobs?.length) return Response.json({ processed: false, message: "Aucun job direct en attente" });

  let succeeded = 0;
  let failed = 0;
  await mapWithConcurrency(jobs as DocumentJob[], CONCURRENCY, async (job) => {
    try {
      const result = await extractInvoice(job, supabase, apiKey);
      const now = new Date().toISOString();
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
      await anthropicFetch(`/v1/files/${result.fileId}`, apiKey, { method: "DELETE" }).catch(() => null);
      await supabase.from("document_jobs").update({ anthropic_file_id: null, updated_at: new Date().toISOString() }).eq("id", job.id);
      succeeded++;
    } catch (error) {
      const terminal = job.attempt_count >= MAX_ATTEMPTS || !isRetryableProcessingError(error);
      await supabase.from("document_jobs").update({
        status: terminal ? "failed" : "direct_queued",
        last_error: error instanceof Error ? error.message.slice(0, 1000) : "Erreur OCR directe",
        updated_at: new Date().toISOString(),
      }).eq("id", job.id).eq("status", "direct_processing");
      failed++;
    }
  });

  return Response.json({
    processed: true,
    mode: "direct",
    claimed: jobs.length,
    succeeded,
    failed,
    duration_ms: Date.now() - startedAt,
  });
});
