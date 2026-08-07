import { NextResponse } from "next/server";
import { getUserContext } from "@/lib/auth";

export const runtime = "nodejs";
// Doit rester >= au maxDuration de la fonction Python (vercel.json), sinon Next
// coupe la connexion pendant que le générateur travaille encore.
export const maxDuration = 300;

const REPORTS = new Set(["commune", "avant_apres", "synthese"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const uuidList = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && UUID.test(x)).slice(0, max) : [];

/** Traduit le message brut du générateur en message affichable à l'utilisateur. */
function friendly(raw: string): string {
  if (raw.includes("openpyxl")) return "openpyxl introuvable sur la fonction Python (vérifiez requirements.txt).";
  if (raw.includes("Aucune facture")) return "Aucune facture dans le périmètre demandé.";
  if (raw.includes("date de bascule")) {
    return "Dates de travaux inconnues pour cette commune — saisissez une date de bascule avant/après.";
  }
  return "Échec de la génération du rapport.";
}

export async function POST(request: Request) {
  const ctx = await getUserContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const report = String(body.report ?? "");
  if (!REPORTS.has(report)) return NextResponse.json({ error: "Type de rapport inconnu." }, { status: 400 });
  if ((report === "commune" || report === "avant_apres") && !UUID.test(String(body.communeId ?? ""))) {
    return NextResponse.json({ error: "Choisissez une commune." }, { status: 400 });
  }

  // orgId vient TOUJOURS du contexte serveur, jamais du body : le générateur Python
  // tourne avec la service-role key (RLS contournée), donc ce filtre est la SEULE
  // protection contre une fuite cross-org sur ce chemin.
  const params: Record<string, unknown> = { report, dataLogger: !!body.dataLogger, orgId: ctx.orgId };
  const requestedCommuneId = UUID.test(String(body.communeId ?? "")) ? String(body.communeId) : null;
  if (requestedCommuneId) params.communeId = requestedCommuneId;
  const ids = uuidList(body.ids, 1200);
  if (ids.length) params.ids = ids;
  const siteIds = uuidList(body.siteIds, 200);
  if (siteIds.length) params.siteIds = siteIds;
  if (DATE.test(String(body.from ?? ""))) params.from = body.from;
  if (DATE.test(String(body.to ?? ""))) params.to = body.to;
  // Date de bascule avant/après quand la commune n'a pas de dates de travaux au référentiel.
  if (DATE.test(String(body.cutover ?? ""))) params.cutover = body.cutover;

  // Secret partagé avec api/internal/generate-report.py. Cette fonction est
  // routable publiquement (toutes le sont sur Vercel) : le secret est ce qui
  // empêche un appel direct avec un orgId arbitraire.
  const secret = process.env.REPORTS_INTERNAL_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "REPORTS_INTERNAL_SECRET manquant dans les variables d'environnement." },
      { status: 500 },
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${secret}`,
  };
  // Sans ce bypass, la Deployment Protection des preview deployments renverrait
  // une page d'auth Vercel à la place de la réponse de la fonction.
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;

  let res: Response;
  try {
    // Origine dérivée de la requête entrante plutôt que de VERCEL_URL : on reste
    // sur le domaine que le client a utilisé (app.abilitysolution.ca) et on évite
    // les surprises de protection sur l'URL technique du déploiement.
    res = await fetch(new URL("/api/internal/generate-report", request.url), {
      method: "POST",
      headers,
      body: JSON.stringify(params),
    });
  } catch (err) {
    console.error("[reports] fonction python injoignable:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "Service de génération injoignable." }, { status: 502 });
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    console.error(`[reports] python ${res.status}:`, raw.slice(0, 2000) || "(réponse vide)");
    let message = raw;
    try {
      message = String((JSON.parse(raw) as { error?: unknown })?.error ?? raw);
    } catch {
      /* réponse non-JSON : on garde le texte brut pour le mapping */
    }
    // 422 = erreur métier attendue côté générateur (périmètre vide, dates manquantes).
    return NextResponse.json({ error: friendly(message) }, { status: res.status === 422 ? 400 : 500 });
  }

  const filename = `rapport-${report}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  return new NextResponse(await res.arrayBuffer(), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
