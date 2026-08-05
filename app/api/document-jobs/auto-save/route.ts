import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUserContext } from "@/lib/auth";
import { invoiceExtractionSchema } from "@/lib/anthropic/invoice-schema";
import { validateInvoice } from "@/lib/anthropic/invoice-validation";
import { matchCommuneScored, matchSiteByContract } from "@/lib/extraction/matching";
import { saveInvoice, escalateHighAnomalies } from "@/lib/invoices/save";
import { recomputeAndPersistAnomalies } from "@/lib/anomalies/persist";

export const runtime = "nodejs";
// Un lot de jobs peut enchaîner plusieurs dizaines d'enregistrements.
export const maxDuration = 300;

/**
 * Enregistrement automatique des documents extraits.
 *
 * Le seuil s'applique **conjointement** à la confiance d'extraction et au score de
 * rapprochement de commune : les deux doivent être au-dessus. Rattacher une facture à
 * la mauvaise commune est bien plus coûteux à corriger qu'une relecture de plus.
 *
 * Trois issues par job :
 *   - autoSaved  : facture créée en `pending_review` avec `auto_saved = true` ;
 *   - duplicates : facture déjà en base, le job est clos en pointant l'existante ;
 *   - toReview   : révision manuelle, avec la meilleure commune pré-remplie même
 *                  sous le seuil (l'utilisateur n'a plus qu'à confirmer).
 */
const AUTO_THRESHOLD = 0.96;

interface AutoSavedEntry { jobId: string; invoiceId: string; factureNumber: string }
interface DuplicateEntry { jobId: string; existingInvoiceId: string; factureNumber: string }
interface ToReviewEntry { jobId: string; factureNumber: string; reason: string }

export async function POST(request: Request) {
  const ctx = await getUserContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = await createClient();
  const body = await request.json().catch(() => ({}));
  const jobIds: string[] | null = Array.isArray(body?.job_ids)
    ? body.job_ids.filter((value: unknown): value is string => typeof value === "string")
    : null;

  let query = supabase
    .from("document_jobs")
    .select("id, file_path, extraction_json")
    .eq("created_by", ctx.userId)
    .eq("status", "needs_review");
  if (jobIds && jobIds.length) query = query.in("id", jobIds);
  const { data: jobs } = await query;

  if (!jobs || jobs.length === 0) {
    return NextResponse.json({ autoSaved: [], toReview: [], duplicates: [] });
  }

  const admin = createAdminClient();
  const autoSaved: AutoSavedEntry[] = [];
  const duplicates: DuplicateEntry[] = [];
  const toReview: ToReviewEntry[] = [];
  const createdInvoiceIds: string[] = [];

  const markCompleted = (jobId: string, invoiceId: string) =>
    admin.from("document_jobs")
      .update({ status: "completed", processed_invoice_id: invoiceId, updated_at: new Date().toISOString() })
      .eq("id", jobId);

  for (const job of jobs) {
    const parsed = invoiceExtractionSchema.safeParse(job.extraction_json);
    if (!parsed.success) {
      toReview.push({ jobId: job.id, factureNumber: "—", reason: "extraction incomplète" });
      continue;
    }
    const extraction = parsed.data;
    const factureNumber = extraction.invoice.facture_number ?? "—";

    const validation = validateInvoice(extraction);
    const commune = await matchCommuneScored(supabase, ctx.orgId, extraction);
    const site = commune
      ? await matchSiteByContract(supabase, ctx.orgId, commune.id, extraction.contract.contract_number)
      : null;

    if (commune) {
      await admin.from("document_jobs")
        .update({ suggested_commune_id: commune.id, suggested_site_id: site?.id ?? null })
        .eq("id", job.id);
    }

    const eligible = !!commune && commune.score >= AUTO_THRESHOLD && validation.confidence >= AUTO_THRESHOLD;
    if (!eligible) {
      const reason = !commune || commune.score < AUTO_THRESHOLD ? "commune incertaine" : "extraction incertaine";
      toReview.push({ jobId: job.id, factureNumber, reason });
      continue;
    }

    // Appel direct plutôt qu'un aller-retour HTTP interne vers /api/invoices : même
    // logique d'enregistrement, sans dépendre de l'origine de la requête ni payer un
    // aller-retour réseau par facture.
    const saved = await saveInvoice(
      supabase,
      { orgId: ctx.orgId, userId: ctx.userId },
      {
        extraction,
        file_path: job.file_path,
        commune_id: commune.id,
        ...(site ? { site_id: site.id } : {}),
        custom_fields: [],
      },
      // Personne n'a relu ces factures : elles arrivent « à contrôler ». Le recalcul
      // portefeuille balaie toute l'organisation, il est fait une seule fois à la fin.
      { status: "pending_review", autoSaved: true, skipPortfolioRecompute: true },
    );

    if (saved.ok) {
      await markCompleted(job.id, saved.invoiceId);
      createdInvoiceIds.push(saved.invoiceId);
      autoSaved.push({ jobId: job.id, invoiceId: saved.invoiceId, factureNumber });
      continue;
    }

    if (saved.status === 409 && saved.existingInvoiceId) {
      // Doublon : rien n'est créé, le job sort de la file en pointant l'existante.
      await markCompleted(job.id, saved.existingInvoiceId);
      duplicates.push({ jobId: job.id, existingInvoiceId: saved.existingInvoiceId, factureNumber });
      continue;
    }

    toReview.push({ jobId: job.id, factureNumber, reason: saved.error });
  }

  if (createdInvoiceIds.length > 0) {
    const { computed } = await recomputeAndPersistAnomalies(supabase, ctx.orgId);
    await escalateHighAnomalies(supabase, ctx.orgId, createdInvoiceIds, computed);
  }

  return NextResponse.json({ autoSaved, toReview, duplicates });
}
