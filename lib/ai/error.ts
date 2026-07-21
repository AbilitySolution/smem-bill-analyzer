// Sanitise les erreurs du fournisseur de modèle avant qu'elles n'atteignent une réponse API
// destinée au navigateur. Le message brut reste disponible côté serveur via `logMessage`
// (à passer à console.error), mais ne doit jamais être renvoyé tel quel au client.

export const GENERIC_UNAVAILABLE_MESSAGE =
  "Le service est temporairement indisponible. Veuillez réessayer plus tard ou contacter l'administrateur si le problème persiste.";

const CREDIT_ERROR_PATTERN = /credit balance|insufficient credit|billing/i;

const VENDOR_LABEL_PATTERN = /\bclaude (files|batch|classify)\b/gi;
const VENDOR_NAME_PATTERN = /\bclaude\b|\banthropic\b/gi;

export function isCreditError(message: string): boolean {
  return CREDIT_ERROR_PATTERN.test(message);
}

// Retire toute mention du fournisseur/modèle d'un message d'erreur, sans toucher
// au contenu factuel utile (code statut, nom de champ manquant, etc.).
function stripVendorName(message: string): string {
  return message
    .replace(VENDOR_LABEL_PATTERN, "Service d'extraction")
    .replace(VENDOR_NAME_PATTERN, "le service d'extraction");
}

export interface SafeError {
  userMessage: string;
  logMessage: string;
}

// Point d'entrée unique : à appeler dans chaque catch avant de renvoyer une erreur au client.
export function toUserSafeError(error: unknown): SafeError {
  const raw = error instanceof Error ? error.message : String(error);
  if (isCreditError(raw)) {
    return { userMessage: GENERIC_UNAVAILABLE_MESSAGE, logMessage: raw };
  }
  return { userMessage: stripVendorName(raw), logMessage: raw };
}
