// Client HTTP unique vers le fournisseur de modèle utilisé pour l'OCR de factures.
// Toute nouvelle intégration doit passer par ce module plutôt que d'appeler
// api.anthropic.com directement, pour garder la gestion d'erreurs et les retries cohérents.
import { AI_MODEL_PREFILTER, CLASSIFY_PROMPT, CLASSIFY_SYSTEM_PROMPT, classifyTool } from "./edf-extraction.ts";

const AI_API_BASE = "https://api.anthropic.com";
const RETRYABLE_STATUSES = new Set(["408", "409", "429", "500", "502", "503", "504", "529"]);
const FORBIDDEN_FILENAME_CHARS = /[<>:"|?*\x00-\x1f]/;

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
    if (![429, 529].includes(response.status) || attempt === maxAttempts - 1) throw new Error(lastError);
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1000 : 3000));
  }
  throw new Error(lastError);
}

export function safeFilename(filename: string, maxLength = 200): string {
  const separatorPattern = new RegExp(String.fromCharCode(92) + "|/");
  const basename = filename.split(separatorPattern).pop()?.trim() || "document";
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

export function isRetryableProcessingError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  const status = error.message.match(/^(\d{3}):/)?.[1];
  if (!status) return true;
  return RETRYABLE_STATUSES.has(status);
}
