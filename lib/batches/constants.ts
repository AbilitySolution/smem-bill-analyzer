import type { ExtractionMediaType } from "@/lib/anthropic/extraction-request";

/**
 * Garde-fous de l'import en lot.
 *
 * L'API Message Batches accepte 100 000 requêtes et 256 Mo par lot. Le base64 gonfle
 * les binaires d'environ un tiers, ce qui laisse ~190 Mo de PDF réels. Une facture EDF
 * pèse typiquement moins d'1 Mo, donc la vraie limite est bien au-dessus de ce que
 * quiconque déposera — mais on contrôle quand même, pour renvoyer un message clair
 * invitant à scinder plutôt que de laisser Anthropic rejeter la soumission entière.
 */
export const MAX_FILES_PER_BATCH = 100;

/** Budget base64 cumulé, sous les 256 Mo de l'API avec de la marge pour l'enveloppe JSON. */
export const MAX_BATCH_BASE64_BYTES = 200 * 1024 * 1024;

/** Extensions retenues à la lecture du ZIP — alignées sur ce que sait lire l'extraction. */
export const ACCEPTED_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".webp"] as const;

const EXTENSION_MEDIA_TYPES: Record<string, ExtractionMediaType> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/**
 * Type MIME déduit du nom de fichier.
 *
 * Le `type` du Blob rendu par le storage est en principe correct, mais un ZIP produit
 * par un outil tiers peut avoir été déposé avec un content-type générique
 * (`application/octet-stream`) : l'extension reste la source la plus fiable.
 */
export function mediaTypeFromName(name: string): ExtractionMediaType | null {
  const ext = name.split(".").pop()?.toLowerCase();
  return ext ? (EXTENSION_MEDIA_TYPES[ext] ?? null) : null;
}
