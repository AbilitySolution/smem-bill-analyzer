import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 120;

const REPORTS = new Set(["commune", "site", "synthese", "avant_apres", "tarifs"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout: 110_000, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stderr: String(stderr ?? (err?.message ?? "")) });
    });
  });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const report = String(body.report ?? "");
  if (!REPORTS.has(report)) return NextResponse.json({ error: "Type de rapport inconnu." }, { status: 400 });
  if (report === "commune" && !UUID.test(String(body.communeId ?? ""))) {
    return NextResponse.json({ error: "Choisissez une commune." }, { status: 400 });
  }
  if (report === "site" && !UUID.test(String(body.siteId ?? ""))) {
    return NextResponse.json({ error: "Choisissez un site." }, { status: 400 });
  }

  const params: Record<string, unknown> = { report, dataLogger: !!body.dataLogger };
  if (UUID.test(String(body.communeId ?? ""))) params.communeId = body.communeId;
  if (UUID.test(String(body.siteId ?? ""))) params.siteId = body.siteId;
  if (DATE.test(String(body.from ?? ""))) params.from = body.from;
  if (DATE.test(String(body.to ?? ""))) params.to = body.to;

  const script = join(process.cwd(), "scripts", "reports", "generate_report.py");
  const outPath = join(tmpdir(), `ability-report-${randomUUID()}.xlsx`);
  const { code, stderr } = await run("python3", [script, JSON.stringify(params), outPath], {
    ...process.env,
    SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  if (code !== 0) {
    console.error("[reports] python:", stderr.slice(0, 2000));
    const friendly = stderr.includes("openpyxl")
      ? "Python/openpyxl introuvable sur le serveur (pip3 install openpyxl)."
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
