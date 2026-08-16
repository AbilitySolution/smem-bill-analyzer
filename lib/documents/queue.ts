/**
 * Garde-fous de la file de traitement, partagés entre le navigateur (sélection des
 * fichiers) et le serveur (route d'entrée).
 *
 * Le navigateur filtre pour donner un retour immédiat ; le serveur revalide tout, y
 * compris les magic bytes — un client peut mentir sur le type déclaré.
 *
 * Les octets des fichiers ne transitent PLUS par `POST /api/document-jobs` : ils sont
 * envoyés directement du navigateur vers le bucket Supabase Storage (policy RLS
 * `org_upload_invoice_files`, `20260801000003_rls_performance.sql` — vérifie déjà que
 * le chemin commence par `{org_id}/{user_id}/`, aucun contournement possible côté
 * client). La route ne reçoit plus qu'un lot de métadonnées JSON (chemins déjà
 * déposés) ; elle retélécharge chaque fichier depuis le bucket pour revalider les
 * magic bytes avant de créer la ligne `document_jobs`.
 *
 * Pourquoi ce détour : une Vercel Function a un plafond de corps de requête entrant de
 * **4,5 Mo, fixe, non configurable** (`FUNCTION_PAYLOAD_TOO_LARGE` — vérifié sur la doc
 * Vercel, pas supposé). `proxyClientMaxBodySize` (next.config.ts) ne règle QUE le
 * tampon du proxy Next, une couche AU-DESSUS de ce plafond — aucune valeur qu'on y met
 * ne peut le dépasser. Un seul PDF de plus de 4,5 Mo (bien en dessous de
 * `MAX_FILE_SIZE`) suffisait à le déclencher, indépendamment du regroupement par lot.
 */

import { safeFileName } from "@/lib/extraction/storage-path";

/**
 * Chemin de dépôt d'un document en file, identique à ce que la route posait
 * elle-même avant ce changement — seul l'appelant (désormais le navigateur) change.
 * Les deux premiers segments sont ceux vérifiés par la policy RLS
 * `org_upload_invoice_files` : un chemin construit autrement est rejeté à l'écriture,
 * pas seulement ignoré.
 */
export function buildQueueStoragePath(orgId: string, userId: string, jobId: string, originalName: string): string {
  return `${orgId}/${userId}/queue/${jobId}-${safeFileName(originalName)}`;
}

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
/**
 * Documents retenus en une sélection. Au-delà, on invite à scinder.
 *
 * Pur garde-fou de rendu navigateur (liste non virtualisée) — aucune limite serveur
 * n'existe sur le total par organisation. Doit rester égal à la limite `.limit(...)`
 * de `GET /api/document-jobs` ([app/api/document-jobs/route.ts]) : sinon la file
 * affichée ne pourrait jamais dépasser l'ancienne valeur même si plus de documents
 * sont réellement en attente.
 */
export const MAX_FILES = 1000;
/** Poids d'une archive ZIP acceptée à la lecture navigateur. */
export const MAX_ARCHIVE_SIZE = 100 * 1024 * 1024;
/** Poids cumulé d'une sélection. */
export const MAX_TOTAL_SIZE = 2 * 1024 * 1024 * 1024;
/**
 * Entrées de métadonnées par appel à `POST /api/document-jobs` (un fichier déjà
 * déposé dans le bucket = une entrée, quelques centaines d'octets de JSON — plus
 * question de taille de corps ici). Borne la DURÉE de la requête, pas son poids :
 * chaque entrée fait retélécharger son fichier depuis le bucket pour revalider les
 * magic bytes, un aller-retour réseau par document.
 */
export const MAX_FILES_PER_REQUEST = 50;
/**
 * Jobs réservés par une invocation du worker `direct`.
 *
 * Aligné sur `claim_direct_document_jobs`, qui borne sa réservation à 10
 * (`LIMIT LEAST(GREATEST(job_limit, 1), 10)`), et sur `MAX_JOBS` de l'Edge Function.
 * Le navigateur découpe donc ses invocations : sans ça, un dépôt de 20 documents en
 * mode rapide n'en démarrait que 10, les autres attendaient le tick de Cron.
 */
export const DIRECT_JOBS_PER_INVOCATION = 10;
/**
 * Documents dispatchés par invocation du worker `batch`.
 *
 * Miroir de `MAX_DOCUMENTS_PER_INVOCATION`/`TARGET_BATCH_SIZE` (`supabase/functions/
 * process-document-queue/index.ts`) — même symptôme que `DIRECT_JOBS_PER_INVOCATION`
 * ci-dessus : un dépôt de plus de ce budget en mode lot ne démarrait que les premiers
 * via l'appel opportuniste du navigateur, les autres attendaient le tick de Cron
 * suivant (1 min, partagé entre toutes les organisations). Le navigateur boucle donc
 * dessus aussi. Valeur alignée sur le plafond déjà en place côté RPC
 * (`claim_fair_document_jobs`/`claim_org_document_jobs` : `LEAST(job_limit, 100)`,
 * `20260806000002_bigger_batches.sql`) — aucune migration nécessaire pour l'atteindre.
 */
export const BATCH_JOBS_PER_INVOCATION = 100;

/**
 * Découpe une liste (fichiers, ou métadonnées de fichiers déjà déposés) par comptage
 * pur — plus de critère de poids : les octets ne transitent plus par cette route, le
 * découpage ne borne que la durée côté serveur (`MAX_FILES_PER_REQUEST`).
 */
export function chunkForUpload<T>(items: T[]): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += MAX_FILES_PER_REQUEST) {
    chunks.push(items.slice(i, i + MAX_FILES_PER_REQUEST));
  }
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
