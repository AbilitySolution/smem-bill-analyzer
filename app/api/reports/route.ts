import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getUserContext } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 120;

const REPORTS = new Set(["commune", "avant_apres", "synthese"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const uuidList = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && UUID.test(x)).slice(0, max) : [];

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout: 110_000, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stderr: String(stderr ?? (err?.message ?? "")) });
    });
  });
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

  // orgId toujours transmis, quel que soit le rôle/type de rapport : le générateur
  // Python tourne avec la service-role key (contourne RLS) donc ce filtre est la
  // SEULE protection contre une fuite cross-org sur ce chemin.
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

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY manquant dans les variables d'environnement." }, { status: 500 });
  }

  const script = join(process.cwd(), "scripts", "reports", "generate_report.py");
  const outPath = join(tmpdir(), `ability-report-${randomUUID()}.xlsx`);
  // Windows installe l'interpréteur sous « python » (pas de shim python3) ; Linux/Render sous « python3 ».
  const python = process.platform === "win32" ? "python" : "python3";
  const { code, stderr } = await run(python, [script, JSON.stringify(params), outPath], {
    ...process.env,
    SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  if (code !== 0) {
    console.error("[reports] python:", stderr.slice(0, 2000));
    const friendly = stderr.includes("openpyxl")
      ? "Python/openpyxl introuvable sur le serveur (pip3 install openpyxl)."
      : stderr.includes("Aucune facture")
        ? "Aucune facture dans le périmètre demandé."
        : stderr.includes("date de bascule")
          ? "Dates de travaux inconnues pour cette commune — saisissez une date de bascule avant/après."
          : "Échec de la génération du rapport.";
    return NextResponse.json({ error: friendly }, { status: 500 });
  }

  try {
    const buffer = await readFile(outPath);
    const filename = `rapport-${report}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } finally {
    unlink(outPath).catch(() => {});
  }
}
