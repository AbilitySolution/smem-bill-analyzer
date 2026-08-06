// Client HTTP unique vers le fournisseur de modèle utilisé pour l'OCR de factures.
// Toute nouvelle intégration doit passer par ce module plutôt que d'appeler l'API
// directement, pour garder la gestion d'erreurs et les relances cohérentes.
import { AI_MODEL_PREFILTER, CLASSIFY_PROMPT, CLASSIFY_SYSTEM_PROMPT, classifyTool } from "./edf-extraction.ts";

const AI_API_BASE = "https://api.anthropic.com";
const RETRYABLE_STATUSES = new Set(["408", "409", "429", "500", "502", "503", "504", "529"]);
// Les deux séparateurs de chemin en font partie : le nom envoyé au fournisseur doit être
// un nom de fichier nu, jamais un chemin.
const FORBIDDEN_FILENAME_CHARS = /[<>:"|?*/\\\x00-\x1f]/;
/** Antislash ou slash. */
const PATH_SEPARATORS = /[\\/]/;

export async function aiRequest(path: string, apiKey: string, init: RequestInit, maxAttempts = 3): Promise<Response> {
  let lastError = "Erreur du service d'extraction";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(`${AI_API_BASE}${path}`, {
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
    // Seuls 429 (rate limit) et 529 (surcharge) valent une relance immédiate : les
    // autres codes ne changeront pas d'avis en une seconde.
    if (![429, 529].includes(response.status) || attempt === maxAttempts - 1) throw new Error(lastError);
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1000 : 3000));
  }
  throw new Error(lastError);
}

/**
 * Nom de fichier acceptable par l'API Files du fournisseur.
 *
 * ⚠️ Le motif de séparateur était `new RegExp("\\" + "|/")`, soit `/\|\//` : un pipe
 * ÉCHAPPÉ suivi d'un slash. Il ne reconnaissait donc ni `\` ni `/` mais la séquence
 * littérale `|/`, et aucun chemin n'était réduit à son nom de fichier. Un import de
 * dossier (`original_name = "factures/facture_123.pdf"`) partait tel quel et le
 * fournisseur répondait 400 « filename: includes a forbidden character » — échec
 * définitif, non rejouable, sur chaque document d'un sous-dossier.
 */
export function safeFilename(filename: string, maxLength = 200): string {
  const basename = filename.split(PATH_SEPARATORS).pop()?.trim() || "document";
  const sanitized = Array.from(basename.normalize("NFKC"))
    .map((character) => FORBIDDEN_FILENAME_CHARS.test(character) ? "_" : character)
    .join("")
    .trim() || "document";
  const characters = Array.from(sanitized);
  if (characters.length <= maxLength) return sanitized;
  const extensionIndex = sanitized.lastIndexOf(".");
  const extension = extensionIndex > 0 ? sanitized.slice(extensionIndex, extensionIndex + 16) : "";
  return `${characters.slice(0, maxLength - Array.from(extension).length).join("")}${extension}`;
}

export async function uploadDocument(file: Blob, filename: string, apiKey: string): Promise<string> {
  const formData = new FormData();
  formData.append("file", file, safeFilename(filename));
  const response = await aiRequest("/v1/files", apiKey, { method: "POST", body: formData });
  return (await response.json() as { id: string }).id;
}

export async function deleteDocument(fileId: string | null, apiKey: string): Promise<void> {
  if (!fileId) return;
  await aiRequest(`/v1/files/${fileId}`, apiKey, { method: "DELETE" }).catch(() => null);
}

/**
 * Supprime le fichier distant d'un job et efface le pointeur `anthropic_file_id`.
 *
 * Remplace le couple « deleteDocument puis UPDATE à NULL » écrit à l'identique dans les
 * trois workers, avec une différence délibérée : le pointeur n'est effacé QUE si la
 * suppression distante a réussi (ou si le fichier n'existe déjà plus — 404). Effacer le
 * pointeur sur un échec de suppression recréerait exactement la fuite que ce helper
 * corrige : un PDF confidentiel resterait chez le fournisseur sans plus aucun moyen de
 * le supprimer. En cas d'échec réel, le pointeur reste en base et le réconciliateur de
 * maintenance retentera au prochain passage.
 *
 * Renvoie `true` si le job ne référence plus de fichier distant à l'issue de l'appel.
 */
export async function releaseRemoteFile(
  // Client service-role ; typé structurellement pour rester importable par les tests.
  // deno-lint-ignore no-explicit-any
  supabase: any,
  jobId: string,
  apiKey: string,
): Promise<boolean> {
  const { data: job } = await supabase
    .from("document_jobs").select("anthropic_file_id").eq("id", jobId).maybeSingle();
  const fileId = job?.anthropic_file_id as string | null | undefined;
  if (!fileId) return true;

  try {
    await aiRequest(`/v1/files/${fileId}`, apiKey, { method: "DELETE" });
  } catch (error) {
    const status = error instanceof Error ? error.message.match(/^(\d{3}):/)?.[1] : null;
    // 404 : déjà supprimé ou expiré côté fournisseur — l'objectif est atteint.
    if (status !== "404") return false;
  }

  await supabase.from("document_jobs")
    .update({ anthropic_file_id: null, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  return true;
}

/**
 * Pré-filtrage : une classification à un tour sur une page unique avec un modèle bon
 * marché, avant de payer l'extraction complète. Lève si la réponse est inexploitable —
 * les appelants avalent l'exception et laissent passer le document (biais volontaire
 * vers l'acceptation : une panne du pré-filtre coûte de l'argent, elle ne perd rien).
 */
export async function classifyDocument(fileId: string, mimeType: string, apiKey: string) {
  const blockType = mimeType === "application/pdf" ? "document" : "image";
  const response = await aiRequest("/v1/messages", apiKey, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: AI_MODEL_PREFILTER,
      max_tokens: 60,
      system: CLASSIFY_SYSTEM_PROMPT,
      tools: [classifyTool],
      tool_choice: { type: "tool", name: "classify_document" },
      messages: [{
        role: "user",
        content: [
          { type: blockType, source: { type: "file", file_id: fileId } },
          { type: "text", text: CLASSIFY_PROMPT },
        ],
      }],
    }),
  });
  const message = await response.json() as { content?: Array<{ type: string; input?: unknown }> };
  const toolUse = message.content?.find((block) => block.type === "tool_use");
  const input = toolUse?.input as { is_facture_electricite?: unknown; type_document?: unknown } | undefined;
  if (!input || typeof input.is_facture_electricite !== "boolean") throw new Error("Classification invalide");
  return { isInvoice: input.is_facture_electricite, type: typeof input.type_document === "string" ? input.type_document : "autre" };
}

/** Sans code statut identifiable, on relance : mieux vaut réessayer que perdre un document. */
export function isRetryableProcessingError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  const status = error.message.match(/^(\d{3}):/)?.[1];
  if (!status) return true;
  return RETRYABLE_STATUSES.has(status);
}
