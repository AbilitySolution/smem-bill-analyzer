import type { SupabaseClient } from "@supabase/supabase-js";
import { createAnthropicClient } from "@/lib/anthropic/client";
import { parseExtractionResponse } from "@/lib/anthropic/extraction-request";
import { matchCommune, matchSiteByContract } from "@/lib/extraction/matching";
import { saveInvoice, escalateHighAnomalies } from "@/lib/invoices/save";
import { recomputeAndPersistAnomalies } from "@/lib/anomalies/persist";
import type { InvoiceExtraction } from "@/lib/anthropic/invoice-schema";

type AnySupabaseClient = SupabaseClient;

/** Au-delà, un lot resté en `importing` est considéré comme abandonné et peut être repris. */
const STALE_IMPORT_MINUTES = 15;

export interface SyncOutcome {
  status: "pending" | "done" | "failed";
  /** État du lot chez Anthropic, pour l'affichage tant qu'il tourne. */
  processing_status?: string;
  total: number;
  imported: number;
  needs_commune: number;
  skipped_duplicate: number;
  failed: number;
}

interface BatchRow {
  id: string;
  org_id: string;
  anthropic_batch_id: string | null;
  status: string;
  created_by: string | null;
  total_count: number;
}

/**
 * Sonde un lot chez Anthropic et, s'il est terminé, importe ses résultats.
 *
 * **Idempotent par construction** : c'est l'exigence centrale, puisque l'UI et le cron
 * peuvent appeler cette fonction en même temps ou successivement sur un lot déjà traité.
 * Trois mécanismes s'en chargent :
 *   1. un verrou par transition d'état `submitted → importing`, atomique côté Postgres ;
 *   2. seuls les items encore `pending` sont traités ;
 *   3. le contrôle de doublon sur `facture_number` dans `saveInvoice` rattrape tout ce
 *      qui aurait échappé aux deux premiers.
 */
export async function syncBatch(
  supabase: AnySupabaseClient,
  batchId: string,
): Promise<SyncOutcome> {
  const { data: batch } = await supabase
    .from("extraction_batches")
    .select("id, org_id, anthropic_batch_id, status, created_by, total_count")
    .eq("id", batchId)
    .maybeSingle();

  if (!batch) throw new Error("Lot introuvable.");
  const row = batch as BatchRow;

  if (row.status === "done" || row.status === "failed" || row.status === "canceled") {
    return await tally(supabase, row, row.status === "done" ? "done" : "failed");
  }
  if (!row.anthropic_batch_id) {
    return await tally(supabase, row, "pending");
  }

  const anthropic = createAnthropicClient();
  const remote = await anthropic.messages.batches.retrieve(row.anthropic_batch_id);

  if (remote.processing_status !== "ended") {
    const outcome = await tally(supabase, row, "pending");
    return { ...outcome, processing_status: remote.processing_status };
  }

  if (!row.created_by) {
    throw new Error("Lot sans auteur : impossible d'attribuer les factures créées.");
  }

  // Verrou : la transition n'aboutit que pour un seul appelant. Toute autre exécution
  // concurrente voit 0 ligne mise à jour et se retire sans rien importer.
  //
  // On accepte aussi de reprendre un lot resté en `importing` depuis plus de
  // STALE_IMPORT_MINUTES : sans cette reprise, un processus interrompu en plein import
  // (redéploiement, timeout de fonction) laisserait le lot bloqué définitivement. Le
  // risque de double exécution reste couvert par le filtre sur les items `pending` et
  // par le contrôle de doublon sur `facture_number`.
  const staleBefore = new Date(Date.now() - STALE_IMPORT_MINUTES * 60_000).toISOString();
  const { data: locked } = await supabase
    .from("extraction_batches")
    .update({ status: "importing", updated_at: new Date().toISOString() })
    .eq("id", batchId)
    .or(`status.eq.submitted,and(status.eq.importing,updated_at.lt.${staleBefore})`)
    .select("id");

  if (!locked || locked.length === 0) {
    return await tally(supabase, row, "pending");
  }

  try {
    const { data: pendingItems } = await supabase
      .from("extraction_batch_items")
      .select("id, file_path, original_name")
      .eq("batch_id", batchId)
      .eq("status", "pending");

    const pendingById = new Map(
      (pendingItems ?? []).map((i) => [i.id as string, i as { id: string; file_path: string; original_name: string }]),
    );
    const importedIds: string[] = [];

    const results = await anthropic.messages.batches.results(row.anthropic_batch_id);

    for await (const entry of results) {
      // Les résultats reviennent dans un ordre quelconque : on indexe par custom_id,
      // jamais par position.
      const item = pendingById.get(entry.custom_id);
      if (!item) continue; // déjà traité par un appel précédent, ou item d'un autre lot

      const patch = await importOne(supabase, row, entry, item.file_path);
      await supabase
        .from("extraction_batch_items")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", entry.custom_id);

      if (patch.status === "imported" && patch.invoice_id) importedIds.push(patch.invoice_id);
    }

    // Recalcul portefeuille UNE SEULE FOIS pour tout le lot : `saveInvoice` l'a sauté
    // pour chaque facture (il balaie toute l'organisation, ce serait quadratique).
    if (importedIds.length > 0) {
      const { computed } = await recomputeAndPersistAnomalies(supabase, row.org_id);
      await escalateHighAnomalies(supabase, row.org_id, importedIds, computed);
    }

    return await tally(supabase, row, "done");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Import du lot échoué.";
    await supabase
      .from("extraction_batches")
      .update({ status: "failed", error: message, updated_at: new Date().toISOString() })
      .eq("id", batchId);
    throw err;
  }
}

type ItemPatch = {
  status: "imported" | "needs_commune" | "skipped_duplicate" | "failed";
  extraction?: InvoiceExtraction;
  suggested_commune_id?: string | null;
  suggested_site_id?: string | null;
  invoice_id?: string;
  input_tokens?: number;
  output_tokens?: number;
  error?: string;
};

/** Traite un résultat du batch : parse, rapproche, enregistre. Ne lève jamais — un
 *  document en échec ne doit pas interrompre l'import des autres. */
async function importOne(
  supabase: AnySupabaseClient,
  batch: BatchRow,
  // Le type exact varie selon la version du SDK ; on ne lit que des champs stables.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entry: any,
  filePath: string,
): Promise<ItemPatch> {
  const result = entry.result;

  if (result?.type !== "succeeded") {
    const reason =
      result?.type === "errored" ? (result.error?.error?.message ?? "erreur du modèle")
      : result?.type === "expired" ? "expiré (non traité sous 24 h)"
      : result?.type === "canceled" ? "annulé"
      : "résultat inattendu";
    return { status: "failed", error: reason };
  }

  const message = result.message;
  const usage = {
    input_tokens: message?.usage?.input_tokens ?? undefined,
    output_tokens: message?.usage?.output_tokens ?? undefined,
  };

  const parsed = parseExtractionResponse(message?.content ?? []);
  if (!parsed.ok) {
    return { status: "failed", error: parsed.error, ...usage };
  }

  const commune = await matchCommune(supabase, batch.org_id, parsed.data);
  const site = commune
    ? await matchSiteByContract(supabase, batch.org_id, commune.id, parsed.data.contract.contract_number)
    : null;

  // Sans commune identifiée, `saveInvoice` refuserait de toute façon (il exige une
  // commune ou un site). On conserve l'extraction pour que l'utilisateur n'ait qu'à
  // désigner la commune, sans repayer d'appel au modèle.
  if (!commune) {
    return {
      status: "needs_commune",
      extraction: parsed.data,
      suggested_commune_id: null,
      suggested_site_id: null,
      ...usage,
    };
  }

  const saved = await saveInvoice(
    supabase,
    { orgId: batch.org_id, userId: batch.created_by! },
    {
      extraction: parsed.data,
      file_path: filePath,
      commune_id: commune.id,
      ...(site ? { site_id: site.id } : {}),
      custom_fields: [],
    },
    // Personne n'a encore relu ces factures : elles arrivent en `pending_review` et
    // se traitent dans /documents/extraction.
    { status: "pending_review", skipPortfolioRecompute: true },
  );

  if (!saved.ok) {
    // 409 = facture déjà en base. Ce n'est pas une erreur d'import : le ZIP contenait
    // un document déjà traité.
    if (saved.status === 409) {
      return {
        status: "skipped_duplicate",
        extraction: parsed.data,
        suggested_commune_id: commune.id,
        suggested_site_id: site?.id ?? null,
        error: saved.error,
        ...usage,
      };
    }
    return { status: "failed", extraction: parsed.data, error: saved.error, ...usage };
  }

  return {
    status: "imported",
    extraction: parsed.data,
    suggested_commune_id: commune.id,
    suggested_site_id: site?.id ?? null,
    invoice_id: saved.invoiceId,
    ...usage,
  };
}

/** Recompte les items et met le lot à jour. Source de vérité : les items, pas des compteurs incrémentés. */
async function tally(
  supabase: AnySupabaseClient,
  batch: BatchRow,
  status: SyncOutcome["status"],
): Promise<SyncOutcome> {
  const { data: items } = await supabase
    .from("extraction_batch_items")
    .select("status")
    .eq("batch_id", batch.id);

  const rows = (items ?? []) as Array<{ status: string }>;
  const count = (s: string) => rows.filter((r) => r.status === s).length;

  const outcome: SyncOutcome = {
    status,
    total: rows.length || batch.total_count,
    imported: count("imported"),
    needs_commune: count("needs_commune"),
    skipped_duplicate: count("skipped_duplicate"),
    failed: count("failed"),
  };

  if (status === "done") {
    await supabase
      .from("extraction_batches")
      .update({
        status: "done",
        imported_count: outcome.imported,
        failed_count: outcome.failed,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", batch.id);
  }

  return outcome;
}
