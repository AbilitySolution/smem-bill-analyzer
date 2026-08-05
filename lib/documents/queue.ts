/**
 * Garde-fous de la file de traitement, partagés entre le navigateur (sélection des
 * fichiers) et le serveur (route d'entrée).
 *
 * Le navigateur filtre pour donner un retour immédiat ; le serveur revalide tout, y
 * compris les magic bytes — un client peut mentir sur le type déclaré.
 */

export const ACCEPTED_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type AcceptedMimeType = (typeof ACCEPTED_MIME_TYPES)[number];

const EXTENSION_MIME_TYPES: Record<string, AcceptedMimeType> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** Aligné sur le CHECK `file_size` de `document_jobs` et sur la limite du bucket. */
export const MAX_FILE_SIZE = 20 * 1024 * 1024;
/** Documents retenus en une sélection. Au-delà, on invite à scinder. */
export const MAX_FILES = 200;
/** Poids d'une archive ZIP acceptée à la lecture navigateur. */
export const MAX_ARCHIVE_SIZE = 100 * 1024 * 1024;
/** Poids cumulé d'une sélection. */
export const MAX_TOTAL_SIZE = 500 * 1024 * 1024;
/** Documents par appel à `POST /api/document-jobs` — borne la taille du multipart. */
export const MAX_FILES_PER_REQUEST = 10;
/**
 * Volume cumulé par appel.
 *
 * Le nombre de fichiers ne suffit pas à borner le multipart : 10 × 20 Mo dépasserait
 * le plafond de corps de requête de la plateforme (100 Mo sur Vercel Functions). Le
 * navigateur découpe donc la sélection sur les deux critères, avec de la marge pour
 * l'enveloppe MIME.
 */
export const MAX_REQUEST_BYTES = 40 * 1024 * 1024;

/**
 * Découpe une sélection en envois qui respectent les deux bornes.
 *
 * Un fichier seul dépassant le budget part quand même dans son propre envoi : il est
 * déjà sous `MAX_FILE_SIZE`, donc toujours largement sous le plafond de la plateforme.
 */
export function chunkForUpload<T extends { size: number }>(files: T[]): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;

  for (const file of files) {
    const wouldExceed = current.length >= MAX_FILES_PER_REQUEST
      || (current.length > 0 && currentBytes + file.size > MAX_REQUEST_BYTES);
    if (wouldExceed) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += file.size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
/**
 * En deçà, l'extraction part en mode `direct` (synchrone, quelques secondes, plein
 * tarif). Au-delà, mode `batch` (asynchrone, tarif réduit de 50 %).
 */
export const DIRECT_DOCUMENT_LIMIT = 20;

export function extensionOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

export function mimeTypeFromName(name: string): AcceptedMimeType | null {
  return EXTENSION_MIME_TYPES[extensionOf(name)] ?? null;
}

export function isAcceptedMimeType(value: string): value is AcceptedMimeType {
  return (ACCEPTED_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * Type réel du document, lu dans son en-tête.
 *
 * C'est la défense contre l'upload déguisé : un `.pdf` qui contient autre chose est
 * rejeté avant d'atteindre le stockage et l'extraction.
 */
export async function detectDocumentType(file: Blob): Promise<AcceptedMimeType | null> {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return "application/pdf";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** Mode de traitement déduit du volume déposé. */
export function processingModeFor(documentCount: number): "direct" | "batch" {
  return documentCount <= DIRECT_DOCUMENT_LIMIT ? "direct" : "batch";
}
