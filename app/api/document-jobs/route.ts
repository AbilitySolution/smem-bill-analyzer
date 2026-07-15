import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const ALLOWED_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_FILES = 10;

function safeFileName(name: string) {
  return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9.-]/g, "_");
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

  const { data, error } = await supabase.from("document_jobs")
    .select("id, original_name, mime_type, file_size, status, attempt_count, last_error, created_at, updated_at, processed_invoice_id, anthropic_batch_id")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ jobs: data });
}
