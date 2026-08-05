import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getUserContext } from "@/lib/auth";
import { invoiceExtractionSchema } from "@/lib/anthropic/invoice-schema";
import { saveInvoice, escalateHighAnomalies } from "@/lib/invoices/save";
import { recomputeAndPersistAnomalies } from "@/lib/anomalies/persist";
import { matchSiteByContract } from "@/lib/extraction/matching";

export const runtime = "nodejs";

const resolveSchema = z.object({ commune_id: z.string().uuid() });

/**
 * Rattrapage manuel d'un document dont la commune n'a pas été reconnue.
 *
 * L'extraction est déjà en base (colonne `extraction`) : l'utilisateur ne fait que
 * désigner la commune, aucun nouvel appel au modèle n'est payé.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  const { id, itemId } = await params;
  const supabase = await createClient();
  const ctx = await getUserContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = resolveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "commune_id requis." }, { status: 400 });
  }

  const { data: item } = await supabase
    .from("extraction_batch_items")
    .select("id, batch_id, file_path, status, extraction")
    .eq("id", itemId)
    .eq("batch_id", id)
    .eq("org_id", ctx.orgId)
    .maybeSingle();

  if (!item) return NextResponse.json({ error: "Document introuvable." }, { status: 404 });
  if (item.status !== "needs_commune") {
    return NextResponse.json({ error: "Ce document n'est pas en attente d'affectation." }, { status: 409 });
  }

  const extraction = invoiceExtractionSchema.safeParse(item.extraction);
  if (!extraction.success) {
    return NextResponse.json({ error: "Extraction enregistrée illisible." }, { status: 500 });
  }

  const { data: commune } = await supabase
    .from("communes").select("id").eq("id", parsed.data.commune_id).eq("org_id", ctx.orgId).maybeSingle();
  if (!commune) return NextResponse.json({ error: "Commune introuvable." }, { status: 400 });

  const site = await matchSiteByContract(
    supabase, ctx.orgId, parsed.data.commune_id, extraction.data.contract.contract_number,
  );

  const saved = await saveInvoice(
    supabase,
    { orgId: ctx.orgId, userId: ctx.userId },
    {
      extraction: extraction.data,
      file_path: item.file_path,
      commune_id: parsed.data.commune_id,
      ...(site ? { site_id: site.id } : {}),
      custom_fields: [],
    },
    { status: "pending_review", skipPortfolioRecompute: true },
  );

  if (!saved.ok) {
    const status = saved.status === 409 ? "skipped_duplicate" : "failed";
    await supabase.from("extraction_batch_items")
      .update({ status, error: saved.error, updated_at: new Date().toISOString() })
      .eq("id", itemId);
    return NextResponse.json({ error: saved.error }, { status: saved.status });
  }

  await supabase.from("extraction_batch_items")
    .update({
      status: "imported",
      invoice_id: saved.invoiceId,
      suggested_commune_id: parsed.data.commune_id,
      suggested_site_id: site?.id ?? null,
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", itemId);

  // Une facture de plus change le contexte portefeuille (médianes, historiques).
  const { computed } = await recomputeAndPersistAnomalies(supabase, ctx.orgId);
  await escalateHighAnomalies(supabase, ctx.orgId, [saved.invoiceId], computed);

  return NextResponse.json({ invoice_id: saved.invoiceId });
}
