import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { invoiceExtractionSchema } from "@/lib/anthropic/invoice-schema";
import { validateInvoice } from "@/lib/anthropic/invoice-validation";
import { matchCommune } from "@/lib/invoices/commune-match";

// Seuil de confiance pour l'enregistrement automatique (extraction ET rapprochement commune).
const AUTO_THRESHOLD = 0.96;

interface AutoSavedEntry { jobId: string; invoiceId: string; factureNumber: string }
interface DuplicateEntry { jobId: string; existingInvoiceId: string; factureNumber: string }
interface ToReviewEntry { jobId: string; factureNumber: string; reason: string }

/**
 * Traite les jobs `needs_review` : enregistre automatiquement ceux à haute confiance
 * (extraction ≥ 96 % ET commune ≥ 96 %), ignore les doublons (déjà en base), et laisse le reste
 * en révision manuelle (commune pré-remplie avec la meilleure suggestion).
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const jobIds: string[] | null = Array.isArray(body?.job_ids) ? body.job_ids.filter((x: unknown) => typeof x === "string") : null;

  let query = supabase
    .from("document_jobs")
    .select("id, file_path, extraction_json")
    .eq("created_by", authData.user.id)
    .eq("status", "needs_review");
  if (jobIds && jobIds.length) query = query.in("id", jobIds);
  const { data: jobs } = await query;

  if (!jobs || jobs.length === 0) {
    return NextResponse.json({ autoSaved: [], toReview: [], duplicates: [] });
  }

  const { data: communes } = await supabase.from("communes").select("id, nom");
  const admin = createAdminClient();
  const origin = new URL(request.url).origin;
  const cookie = request.headers.get("cookie") ?? "";

  const autoSaved: AutoSavedEntry[] = [];
  const duplicates: DuplicateEntry[] = [];
  const toReview: ToReviewEntry[] = [];

  const markCompleted = (jobId: string, invoiceId: string) =>
    admin.from("document_jobs").update({ status: "completed", processed_invoice_id: invoiceId, updated_at: new Date().toISOString() }).eq("id", jobId);

  for (const job of jobs) {
    const parsed = invoiceExtractionSchema.safeParse(job.extraction_json);
    if (!parsed.success) {
      toReview.push({ jobId: job.id, factureNumber: "—", reason: "extraction incomplète" });
      continue;
    }
    const extraction = parsed.data;
    const factureNumber = extraction.invoice.facture_number ?? "—";

    const validation = validateInvoice(extraction);
    const communeMatch = matchCommune(
      [extraction.commune_hint, extraction.contract.espace_livraison, extraction.client.adresse, extraction.client.nom],
      communes ?? [],
    );

    const eligible =
      !!communeMatch &&
      communeMatch.score >= AUTO_THRESHOLD &&
      validation.confidence >= AUTO_THRESHOLD;

    if (!eligible) {
      // Pré-remplir la meilleure commune (même < seuil) pour la révision manuelle.
      if (communeMatch) {
        await admin.from("document_jobs").update({ suggested_commune_id: communeMatch.id }).eq("id", job.id);
      }
      const reason = !communeMatch || communeMatch.score < AUTO_THRESHOLD ? "commune incertaine" : "extraction incertaine";
      toReview.push({ jobId: job.id, factureNumber, reason });
      continue;
    }

    // Enregistrement via le chemin standard (réutilise toute la logique existante + cookies auth).
    const res = await fetch(`${origin}/api/invoices`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        extraction,
        commune_id: communeMatch.id,
        file_path: job.file_path,
        auto_saved: true,
      }),
    });
    const json = await res.json().catch(() => ({}));

    if (res.status === 409 && json?.duplicate) {
      // Déjà en base : on n'enregistre pas, on sort le job de la file en le pointant sur l'existante.
      await markCompleted(job.id, json.existing_invoice_id);
      duplicates.push({ jobId: job.id, existingInvoiceId: json.existing_invoice_id, factureNumber });
    } else if (res.ok && json?.invoice_id) {
      await markCompleted(job.id, json.invoice_id);
      autoSaved.push({ jobId: job.id, invoiceId: json.invoice_id, factureNumber });
    } else {
      // Échec d'enregistrement : on laisse en révision manuelle.
      toReview.push({ jobId: job.id, factureNumber, reason: json?.error ?? "échec enregistrement" });
    }
  }

  return NextResponse.json({ autoSaved, toReview, duplicates });
}
