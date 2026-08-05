// Les workers sont appelés depuis deux endroits : les `pg_cron` (serveur à serveur, pas
// de CORS) et le navigateur au dépôt, pour démarrer sans attendre le tick suivant. Le
// second déclenche un préflight `OPTIONS` : sans réponse correcte, l'invocation échoue
// silencieusement et l'utilisateur attend jusqu'à une minute pour rien.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Réponse au préflight, ou `null` si la requête est une vraie invocation. */
export function preflightResponse(request: Request): Response | null {
  if (request.method !== "OPTIONS") return null;
  return new Response("ok", { headers: corsHeaders });
}

/** `Response.json` avec les en-têtes CORS. */
// deno-lint-ignore no-explicit-any
export function jsonResponse(body: any, init?: ResponseInit): Response {
  return Response.json(body, {
    ...init,
    headers: { ...corsHeaders, ...(init?.headers ?? {}) },
  });
}
