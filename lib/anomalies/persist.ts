import type { SupabaseClient } from "@supabase/supabase-js";
import { computePortfolioAnomalies, type AnomalyInvoiceInput, type AnomalyLineInput, type ComputedAnomaly } from "./recompute";

// Type générique (pas dérivé de lib/supabase/server, qui dépend de next/headers et
// n'est donc utilisable que dans une requête Next) — permet d'appeler cette fonction
// aussi bien depuis une route API que depuis un script standalone (service-role).
type AnySupabaseClient = SupabaseClient;

/**
 * Types effacés puis réécrits à chaque recalcul.
 *
 * `cout_kwh_bas` et `conso_manquante` n'y figurent plus comme types produits — leurs
 * règles ont été retirées — mais restent dans cette liste de purge : tant qu'un
 * environnement peut encore en héberger, chaque recalcul les balaie. Sans ça, des
 * lignes orphelines survivraient indéfiniment, puisque rien ne les régénère ni ne
 * les supprime.
 */
const RECOMPUTED_TYPES = ["cout_kwh", "cout_kwh_bas", "consumption_spike", "conso_manquante"];

/** SELECT paginé (PostgREST limite à 1000 lignes par requête). */
async function selectAll<T>(
  queryFactory: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = [];
  let start = 0;
  while (true) {
    const { data, error } = await queryFactory(start, start + pageSize - 1);
    if (error) throw new Error(`selectAll: ${JSON.stringify(error)}`);
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < pageSize) return out;
    start += pageSize;
  }
}

/**
 * Recalcule les anomalies "portefeuille" (coût kWh, consommation anormale) pour
 * toute une organisation et remplace les lignes existantes de ces types dans
 * `anomalies` — en conservant le statut `resolved` des anomalies qui réapparaissent
 * à l'identique (même invoice_id + type) pour ne pas rouvrir ce qu'un utilisateur a
 * déjà traité.
 *
 * Les checks structurels à l'extraction (ttc_mismatch, index_inversion,
 * date_inversion, tarif_type_mismatch…) ne sont PAS touchés ici — ils restent
 * gérés à l'insertion dans app/api/invoices/route.ts.
 */
export async function recomputeAndPersistAnomalies(
  supabase: AnySupabaseClient,
  orgId: string,
): Promise<{ computed: ComputedAnomaly[]; preserved: number }> {
  interface InvoiceRow { id: string; site_id: string | null; categorie: "batiment" | "eclairage_public" | null; facture_date: string; total_ttc: number; is_duplicata: boolean }
  const invoices = await selectAll<InvoiceRow>((from, to) =>
    supabase.from("invoices").select("id, site_id, categorie, facture_date, total_ttc, is_duplicata")
      .eq("org_id", orgId).eq("archived", false).range(from, to),
  );
  if (invoices.length === 0) return { computed: [], preserved: 0 };

  // Les trois requêtes ci-dessous passaient la liste complète des identifiants de
  // factures via `.in("invoice_id", …)`. Avec supabase-js, cette liste part
  // dans l'URL — 37 octets par facture, soit 7,7 Ko à 200 factures et 38 Ko à 1 000 —
  // jusqu'à dépasser le plafond de ligne de requête des proxys (414 / 400). Le compteur
  // porte sur le total de l'organisation et ne redescend jamais, et `selectAll` pagine
  // la réponse, pas la requête. Les RPC ne prennent plus que `org_id` : les
  // identifiants ne quittent plus la base.
  interface PeriodRow { invoice_id: string; period_start: string | null; period_end: string | null; consommation_kwh: number | null; montant_eur: number | null }
  const periods = await selectAll<PeriodRow>((from, to) =>
    supabase.rpc("org_anomaly_periods", { target_org: orgId, page_limit: to - from + 1, page_offset: from }),
  );
  const linesByInvoice = new Map<string, AnomalyLineInput[]>();
  for (const p of periods) {
    const arr = linesByInvoice.get(p.invoice_id) ?? [];
    arr.push({ periodStart: p.period_start, periodEnd: p.period_end, kwh: p.consommation_kwh ?? 0, montantEur: p.montant_eur ?? 0 });
    linesByInvoice.set(p.invoice_id, arr);
  }

  const inputs: AnomalyInvoiceInput[] = invoices.map((inv) => ({
    id: inv.id,
    siteId: inv.site_id,
    categorie: inv.categorie,
    factureDate: inv.facture_date,
    totalTtc: inv.total_ttc,
    isDuplicata: inv.is_duplicata,
    lines: linesByInvoice.get(inv.id) ?? [],
  }));

  const computed = computePortfolioAnomalies(inputs);

  interface ExistingRow { invoice_id: string; type: string; resolved: boolean }
  const existing = await selectAll<ExistingRow>((from, to) =>
    supabase.rpc("org_recomputed_anomalies", {
      target_org: orgId, anomaly_types: RECOMPUTED_TYPES, page_limit: to - from + 1, page_offset: from,
    }),
  );
  const resolvedMap = new Map(existing.map((e) => [`${e.invoice_id}:${e.type}`, e.resolved]));

  const { error: deleteErr } = await supabase.rpc("delete_org_recomputed_anomalies", {
    target_org: orgId,
    anomaly_types: RECOMPUTED_TYPES,
  });
  if (deleteErr) throw new Error(`recompute anomalies delete: ${deleteErr.message}`);

  if (computed.length > 0) {
    const rows = computed.map((c) => ({
      invoice_id: c.invoiceId,
      type: c.type,
      severity: c.severity,
      description: c.description,
      detected_value: c.detectedValue,
      expected_range_min: c.expectedRangeMin,
      expected_range_max: c.expectedRangeMax,
      resolved: resolvedMap.get(`${c.invoiceId}:${c.type}`) ?? false,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error: insertErr } = await supabase.from("anomalies").insert(rows.slice(i, i + 500));
      if (insertErr) throw new Error(`recompute anomalies insert: ${insertErr.message}`);
    }
  }

  return { computed, preserved: resolvedMap.size };
}
