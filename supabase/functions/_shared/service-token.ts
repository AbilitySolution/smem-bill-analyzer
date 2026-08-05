/**
 * Distingue un appel de service (Cron, script) d'un appel utilisateur (navigateur).
 *
 * Comparer le jeton à `SUPABASE_SERVICE_ROLE_KEY` ne suffit pas : depuis la bascule vers
 * les nouvelles clés API, plusieurs jetons de service valides coexistent — le JWT
 * `service_role` historique et les clés `sb_secret_…` — et la variable injectée dans la
 * fonction n'est pas forcément celle que l'appelant utilise. Une égalité de chaîne
 * classait alors le Cron comme utilisateur et répondait 401 à chaque tick.
 *
 * La signature du jeton est déjà vérifiée par la plateforme (`verify_jwt = true`) avant
 * d'entrer ici : on ne lit le payload que pour connaître le rôle, jamais pour décider
 * de l'authenticité.
 */

function jwtRole(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
    const payload = JSON.parse(atob(padded)) as { role?: unknown };
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

export function isServiceToken(token: string, serviceRoleKey: string): boolean {
  if (!token) return false;
  if (token === serviceRoleKey) return true;
  // Nouvelles clés secrètes : opaques, non décodables, mais jamais distribuées au client.
  if (token.startsWith("sb_secret_")) return true;
  // JWT historique : seul `service_role` compte. La clé anon est explicitement exclue —
  // elle est publique, elle ne doit pas pouvoir déclencher le traitement de la file.
  return jwtRole(token) === "service_role";
}
