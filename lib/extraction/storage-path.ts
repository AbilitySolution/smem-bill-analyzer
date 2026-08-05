/**
 * Convention de nommage des fichiers du bucket `invoice-files`.
 *
 * Le chemin n'est pas cosmétique : la policy RLS du bucket vérifie que le premier
 * segment est l'org de l'appelant et le second son user id
 * (`20260801000003_rls_performance.sql`, policy `org_upload_invoice_files`).
 * Un chemin construit autrement est rejeté à l'écriture.
 *
 * Partagé entre l'upload serveur (`/api/extract`) et l'upload navigateur de l'import
 * en lot, pour que les deux produisent des chemins identiques.
 */

/** Retire accents et caractères qui gêneraient l'URL, sans perdre l'extension. */
export function safeFileName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .replace(/[^a-zA-Z0-9.-]/g, "_");
}

/**
 * `{org_id}/{user_id}/{timestamp}-{suffixe?}-{nom}`.
 *
 * Le `suffix` sert à l'import en lot : plusieurs fichiers d'un même ZIP sont écrits
 * dans la même milliseconde et, sans lui, un homonyme écraserait le précédent.
 */
export function buildInvoiceStoragePath(
  orgId: string,
  userId: string,
  originalName: string,
  suffix?: string | number,
): string {
  const prefix = suffix === undefined ? `${Date.now()}` : `${Date.now()}-${suffix}`;
  return `${orgId}/${userId}/${prefix}-${safeFileName(originalName)}`;
}
