// Contexte de consommation par site, pour les sparklines de la page Anomalies.
//
// Une alerte « consommation en hausse de 87 % » demande à l'utilisateur de croire une
// affirmation qu'il ne peut pas vérifier. La même alerte accompagnée de l'historique du
// site, avec la bande de référence et le point incriminé, se vérifie d'un coup d'œil.
// C'est la différence entre une détection qu'on subit et une détection qu'on comprend.
//
// Les points sont calculés ici exactement comme dans lib/anomalies/recompute.ts
// (kWh/jour sur la période couverte), pour que le graphique montre bien la grandeur qui
// a servi à déclencher l'alerte — et non une approximation qui la contredirait.
import { createClient } from "@/lib/supabase/server";
import { getUserContext } from "@/lib/auth";
import { median } from "./anomalies";
import { selectAll } from "./invoices";

export interface SitePoint {
  invoiceId: string;
  /** Fin de la période couverte (YYYY-MM-DD) — l'axe des abscisses. */
  periodEnd: string;
  kwhPerDay: number;
}

export interface SiteSeries {
  siteId: string;
  points: SitePoint[];
  /** Médiane des kWh/jour du site — le trait central de la bande de référence. */
  baseline: number | null;
  /** Demi-largeur de la bande (3,5 écarts robustes), alignée sur le seuil de détection. */
  band: number | null;
}

export interface AnomalyContext {
  /** siteId → série de consommation du site. */
  seriesBySite: Record<string, SiteSeries>;
  /** invoiceId → siteId, pour relier une alerte à la série de son site. */
  siteByInvoice: Record<string, string>;
  /** siteId → nombre total de factures non archivées, dénominateur du taux d'anomalie. */
  invoiceCountBySite: Record<string, number>;
}

const DAY = 86_400_000;
/** Aligné sur SPIKE_K dans lib/anomalies/recompute.ts : la bande dessinée EST le seuil. */
const BAND_K = 3.5;
const SIGMA_FLOOR = 0.05;

interface RawPeriod {
  invoice_id: string;
  period_start: string | null;
  period_end: string | null;
  consommation_kwh: number | null;
}

/**
 * Séries de consommation par site sur tout le portefeuille non archivé.
 *
 * Passe par la RPC `org_anomaly_periods` — la même que le recalcul — plutôt que par un
 * `.in("invoice_id", […])` : la liste des identifiants partirait dans l'URL et dépasserait
 * le plafond de ligne de requête des proxys au-delà de quelques centaines de factures.
 */
export async function getAnomalyContext(): Promise<AnomalyContext | null> {
  const ctx = await getUserContext();
  if (!ctx) return null;

  const supabase = await createClient();

  const [periods, invoices] = await Promise.all([
    selectAll<RawPeriod>((from, to) =>
      supabase.rpc("org_anomaly_periods", {
        target_org: ctx.orgId,
        page_limit: to - from + 1,
        page_offset: from,
      }),
    ),
    selectAll<{ id: string; site_id: string | null }>((from, to) =>
      supabase
        .from("invoices")
        .select("id, site_id")
        .eq("org_id", ctx.orgId)
        .eq("archived", false)
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);

  if (!invoices) return null;

  const siteByInvoice: Record<string, string> = {};
  const invoiceCountBySite: Record<string, number> = {};
  for (const inv of invoices) {
    if (!inv.site_id) continue;
    siteByInvoice[inv.id] = inv.site_id;
    invoiceCountBySite[inv.site_id] = (invoiceCountBySite[inv.site_id] ?? 0) + 1;
  }

  // Agrégation par facture : une facture porte plusieurs lignes (HP, HC, Base…) qui
  // décrivent la même période — le kWh/jour se calcule sur leur somme, pas ligne à ligne.
  interface Agg { kwh: number; start: string | null; end: string | null }
  const byInvoice = new Map<string, Agg>();
  for (const p of periods ?? []) {
    const a = byInvoice.get(p.invoice_id) ?? { kwh: 0, start: null, end: null };
    a.kwh += Number(p.consommation_kwh ?? 0);
    if (p.period_start && (!a.start || p.period_start < a.start)) a.start = p.period_start;
    if (p.period_end && (!a.end || p.period_end > a.end)) a.end = p.period_end;
    byInvoice.set(p.invoice_id, a);
  }

  const pointsBySite = new Map<string, SitePoint[]>();
  for (const [invoiceId, agg] of byInvoice) {
    const siteId = siteByInvoice[invoiceId];
    if (!siteId || !agg.start || !agg.end || agg.kwh <= 0) continue;
    const days = (Date.parse(agg.end) - Date.parse(agg.start)) / DAY;
    if (!Number.isFinite(days) || days <= 0) continue;
    const arr = pointsBySite.get(siteId) ?? [];
    arr.push({ invoiceId, periodEnd: agg.end, kwhPerDay: agg.kwh / days });
    pointsBySite.set(siteId, arr);
  }

  const seriesBySite: Record<string, SiteSeries> = {};
  for (const [siteId, pts] of pointsBySite) {
    pts.sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
    const rates = pts.map((p) => p.kwhPerDay).filter((r) => r > 0);
    const baseline = median(rates);
    let band: number | null = null;
    if (baseline && baseline > 0) {
      const mad = median(rates.map((r) => Math.abs(r - baseline))) ?? 0;
      band = BAND_K * Math.max(1.4826 * mad, SIGMA_FLOOR * baseline);
    }
    seriesBySite[siteId] = { siteId, points: pts, baseline, band };
  }

  return { seriesBySite, siteByInvoice, invoiceCountBySite };
}
