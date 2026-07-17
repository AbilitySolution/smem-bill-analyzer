import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fallbackEstimateStats, type ProcessingEstimateStats } from "@/lib/document-processing-estimate";

const ALLOWED_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_FILES = 10;

function safeFileName(name: string) {
  return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9.-]/g, "_");
}

async function detectedDocumentType(file: File) {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

function percentile(sortedValues: number[], ratio: number) {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * ratio) - 1);
  return Math.round(sortedValues[index]);
}

async function processingEstimateStats(): Promise<ProcessingEstimateStats> {
  const fallback = fallbackEstimateStats();
  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin.from("document_batches")
    .select("created_at, completed_at")
    .eq("status", "ended")
    .not("completed_at", "is", null)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error || !data) return fallback;
  const durations = data
    .map((batch) => (new Date(batch.completed_at!).getTime() - new Date(batch.created_at).getTime()) / 1000)
    .filter((seconds) => Number.isFinite(seconds) && seconds > 0 && seconds <= 24 * 60 * 60)
    .sort((a, b) => a - b);

  if (durations.length < 5) return { ...fallback, sampleCount: durations.length };
  return {
    sampleCount: durations.length,
    p50BatchSeconds: percentile(durations, 0.5),
    p80BatchSeconds: percentile(durations, 0.8),
    source: "historical",
    generatedAt: new Date().toISOString(),
  };
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const formData = await request.formData();
  const files = formData.getAll("files").filter((value): value is File => value instanceof File);
  if (!files.length) return NextResponse.json({ error: "Aucun fichier fourni." }, { status: 400 });
  if (files.length > MAX_FILES) return NextResponse.json({ error: `Maximum ${MAX_FILES} fichiers par envoi.` }, { status: 400 });

  for (const file of files) {
    if (!ALLOWED_TYPES.has(file.type)) {
      return NextResponse.json({ error: `${file.name} : format non supporté.` }, { status: 415 });
    }
    if (!file.size || file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: `${file.name} : taille invalide ou supérieure à 20 Mo.` }, { status: 413 });
    }
    if (await detectedDocumentType(file) !== file.type) {
      return NextResponse.json({ error: `${file.name} : le contenu ne correspond pas au format annoncé.` }, { status: 415 });
    }
  }

  const admin = createAdminClient();
  const jobs: Array<{ id: string; original_name: string; status: string }> = [];

  for (const file of files) {
    const jobId = crypto.randomUUID();
    const filePath = `${authData.user.id}/queue/${jobId}-${safeFileName(file.name)}`;
    const { error: uploadError } = await admin.storage.from("invoice-files").upload(
      filePath,
      await file.arrayBuffer(),
      { contentType: file.type, upsert: false },
    );
    if (uploadError) return NextResponse.json({ error: `${file.name} : ${uploadError.message}` }, { status: 500 });

    const { data: job, error: insertError } = await admin.from("document_jobs").insert({
      id: jobId,
      created_by: authData.user.id,
      file_path: filePath,
      original_name: file.name,
      mime_type: file.type,
      file_size: file.size,
      status: "queued",
    }).select("id, original_name, status").single();

    if (insertError || !job) {
      await admin.storage.from("invoice-files").remove([filePath]);
      return NextResponse.json({ error: `${file.name} : ${insertError?.message ?? "création du job impossible"}` }, { status: 500 });
    }

    const { error: queueError } = await admin.rpc("enqueue_document_job", { job_id: job.id });
    if (queueError) {
      await admin.from("document_jobs").update({ status: "failed", last_error: queueError.message }).eq("id", job.id);
    }
    jobs.push(job);
  }

  return NextResponse.json({ jobs }, { status: 202 });
}

export async function GET() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [{ data, error }, estimation] = await Promise.all([
    supabase.from("document_jobs")
      .select("id, original_name, mime_type, file_size, status, attempt_count, last_error, created_at, updated_at, processed_invoice_id, anthropic_batch_id")
      .order("created_at", { ascending: false })
      .limit(200),
    processingEstimateStats(),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ jobs: data, estimation });
}
