import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUserContext } from "@/lib/auth";
import { invoiceExtractionSchema } from "@/lib/anthropic/invoice-schema";
import { validateInvoice } from "@/lib/anthropic/invoice-validation";
import { matchCommuneScored, matchSiteByContract } from "@/lib/extraction/matching";

/**
 * Un document de la file : lecture pour la page de révision, relance, clôture,
 * suppression.
 *
 * La lecture passe par le client de session : la policy `org_read_document_jobs`
 * garantit qu'on ne voit que les jobs de son organisation. Les écritures passent par
 * le client admin — la table n'expose aucune policy d'écriture.
 */

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getUserContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = await createClient();
  const { data: job, error } = await supabase.from("document_jobs").select("*").eq("id", id).maybeSingle();
  if (error || !job) return NextResponse.json({ error: "Job introuvable." }, { status: 404 });

  if (job.status !== "needs_review") {
    return NextResponse.json({ job });
  }

  const extraction = invoiceExtractionSchema.safeParse(job.extraction_json);
  if (!extraction.success) {
    return NextResponse.json(
      { error: "Le résultat OCR est incomplet.", details: extraction.error.format() },
      { status: 422 },
    );
  }

  // Rapprochement au premier affichage. L'enregistrement automatique l'a déjà fait pour
  // les jobs passés par lui ; ce chemin couvre les relances et les ouvertures directes.
  let suggestedCommuneId = job.suggested_commune_id as string | null;
  let suggestedSiteId = job.suggested_site_id as string | null;
  if (!suggestedCommuneId) {
    const commune = await matchCommuneScored(supabase, ctx.orgId, extraction.data);
    if (commune) {
      const site = await matchSiteByContract(
        supabase, ctx.orgId, commune.id, extraction.data.contract.contract_number,
      );
      suggestedCommuneId = commune.id;
      suggestedSiteId = site?.id ?? null;
      await createAdminClient()
        .from("document_jobs")
        .update({ suggested_commune_id: suggestedCommuneId, suggested_site_id: suggestedSiteId })
        .eq("id", id);
    }
  }

  return NextResponse.json({
    job: {
      ...job,
      extraction_json: extraction.data,
      validation_json: validateInvoice(extraction.data),
      suggested_commune_id: suggestedCommuneId,
      suggested_site_id: suggestedSiteId,
    },
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getUserContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = await createClient();
  const body = await request.json().catch(() => ({}));

  if (body.action === "retry") {
    // `retry_document_job` refait le contrôle d'appartenance côté base.
    const { error } = await supabase.rpc("retry_document_job", { job_id: id });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ success: true });
  }

  if (body.action === "complete" && typeof body.invoice_id === "string") {
    // La lecture sous RLS vaut contrôle d'appartenance : un job d'une autre org est
    // invisible et renvoie 404.
    const { data: owned } = await supabase.from("document_jobs").select("id").eq("id", id).maybeSingle();
    if (!owned) return NextResponse.json({ error: "Job introuvable." }, { status: 404 });

    const { error } = await createAdminClient().from("document_jobs").update({
      status: "completed", processed_invoice_id: body.invoice_id, updated_at: new Date().toISOString(),
    }).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Action inconnue." }, { status: 400 });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getUserContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = await createClient();
  const { data: job } = await supabase
    .from("document_jobs").select("id, created_by, file_path").eq("id", id).maybeSingle();
  if (!job) return NextResponse.json({ error: "Job introuvable." }, { status: 404 });

  // Un membre ne supprime que ses propres dépôts ; un administrateur d'organisation
  // peut nettoyer la file entière.
  if (job.created_by !== ctx.userId && ctx.role !== "org_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { error } = await admin.from("document_jobs").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Le fichier ne sert plus à rien une fois le job supprimé : le laisser ferait grossir
  // le bucket sans que rien ne le référence. Non bloquant.
  if (job.file_path) {
    const { error: storageError } = await admin.storage.from("invoice-files").remove([job.file_path]);
    if (storageError) {
      console.error("[document-jobs] fichier non supprimé", { id, path: job.file_path, error: storageError.message });
    }
  }

  return NextResponse.json({ success: true });
}
