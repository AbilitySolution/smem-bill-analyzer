import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { invoiceExtractionSchema } from "@/lib/anthropic/invoice-schema";
import { validateInvoice } from "@/lib/anthropic/invoice-validation";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: job, error } = await supabase.from("document_jobs").select("*").eq("id", id).single();
  if (error || !job) return NextResponse.json({ error: "Job introuvable." }, { status: 404 });

  if (job.status === "needs_review") {
    const extraction = invoiceExtractionSchema.safeParse(job.extraction_json);
    if (!extraction.success) {
      return NextResponse.json({ error: "Le résultat OCR est incomplet.", details: extraction.error.format() }, { status: 422 });
    }
    const validation = validateInvoice(extraction.data);
    return NextResponse.json({ job: { ...job, extraction_json: extraction.data, validation_json: validation } });
  }
  return NextResponse.json({ job });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));

  if (body.action === "retry") {
    const { error } = await supabase.rpc("retry_document_job", { job_id: id });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ success: true });
  }

  if (body.action === "complete" && typeof body.invoice_id === "string") {
    const admin = createAdminClient();
    const { data: owned } = await supabase.from("document_jobs").select("id").eq("id", id).single();
    if (!owned) return NextResponse.json({ error: "Job introuvable." }, { status: 404 });
    const { error } = await admin.from("document_jobs").update({
      status: "completed", processed_invoice_id: body.invoice_id, updated_at: new Date().toISOString(),
    }).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Action inconnue." }, { status: 400 });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Vérifie la propriété avant suppression.
  const { data: job } = await supabase.from("document_jobs").select("id, created_by").eq("id", id).single();
  if (!job) return NextResponse.json({ error: "Job introuvable." }, { status: 404 });
  if (job.created_by !== authData.user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const admin = createAdminClient();
  const { error } = await admin.from("document_jobs").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}

