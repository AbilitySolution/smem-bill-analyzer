/**
 * Notification d'exploitation, best-effort.
 *
 * `OPS_WEBHOOK_URL` (webhook entrant Slack / Teams / autre acceptant `{ text }`) :
 * définie → POST ; absente → le message part dans `console.warn`, visible dans les
 * logs Vercel. Dans tous les cas la fonction n'échoue JAMAIS — une notification ratée
 * ne doit pas faire échouer la maintenance qui la porte.
 */
export async function notifyOps(text: string): Promise<void> {
  const webhookUrl = process.env.OPS_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("[ops-digest]", text);
    return;
  }
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (reason) {
    console.error("[ops-digest] envoi impossible", reason instanceof Error ? reason.message : reason);
    console.warn("[ops-digest]", text);
  }
}
