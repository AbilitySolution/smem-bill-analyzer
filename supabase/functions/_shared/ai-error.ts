// Assainit les erreurs du fournisseur de modèle avant qu'elles n'atteignent une colonne
// lue par le frontend (`document_jobs.last_error`, `document_batches.last_error`).
// Le message brut reste disponible côté serveur via `logMessage` pour le débogage
// (console.error), mais ne doit jamais être renvoyé tel quel au client.

export const GENERIC_UNAVAILABLE_MESSAGE =
  "Le service est temporairement indisponible. Veuillez réessayer plus tard ou contacter l'administrateur si le problème persiste.";

const CREDIT_ERROR_PATTERN = /credit balance|insufficient credit|billing/i;

const VENDOR_LABEL_PATTERN = /\bclaude (files|batch|classify)\b/gi;
const VENDOR_NAME_PATTERN = /\bclaude\b|\banthropic\b/gi;
/**
 * Les URL partent en premier, entières.
 *
 * Le remplacement mot à mot s'appliquait aussi à l'intérieur des liens de documentation
 * du fournisseur, produisant des messages illisibles affichés tels quels à
 * l'utilisateur : `https://docs.le service d'extraction.com/en/docs/build-with-le
 * service d'extraction/files`. Une URL de documentation fournisseur n'aide de toute
 * façon pas l'utilisateur final — et c'est elle qui porte le nom à masquer.
 */
const URL_PATTERN = /https?:\/\/\S+/gi;

export function isCreditError(message: string): boolean {
  return CREDIT_ERROR_PATTERN.test(message);
}

// Retire toute mention du fournisseur/modèle, sans toucher au contenu factuel utile
// (code statut, nom de champ manquant, etc.).
function stripVendorName(message: string): string {
  return message
    .replace(URL_PATTERN, "")
    .replace(VENDOR_LABEL_PATTERN, "Service d'extraction")
    .replace(VENDOR_NAME_PATTERN, "le service d'extraction")
    // Ponctuation orpheline laissée par l'URL retirée (« … at .», « … (). »).
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export interface SafeError {
  userMessage: string;
  logMessage: string;
}

// Point d'entrée unique : à appeler dans chaque catch avant d'écrire dans une colonne
// `last_error` ou de renvoyer une erreur au client.
export function toUserSafeError(error: unknown): SafeError {
  const raw = error instanceof Error ? error.message : String(error);
  if (isCreditError(raw)) {
    return { userMessage: GENERIC_UNAVAILABLE_MESSAGE, logMessage: raw };
  }
  return { userMessage: stripVendorName(raw), logMessage: raw };
}
