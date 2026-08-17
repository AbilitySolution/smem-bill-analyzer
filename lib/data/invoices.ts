import { createClient } from "@/lib/supabase/server";
import { getUserContext } from "@/lib/auth";
import { topSeverity, type AnomalyLite, type Severity } from "./anomalies";
import { DEFAULT_PAGE_SIZE, type CalendarDay, type InvoiceListFilters, type InvoiceListKpis, type SortKey } from "./invoice-list-params";

export * from "./invoice-list-params";

export interface InvoiceDoc {
  id: string;
  number: string;
  date: string; // YYYY-MM-DD
  site: string;
  commune: string;
  categorie: "batiment" | "eclairage_public";
  isDuplicata: boolean;
  totalHt: number;
  tva: number;
  autresTaxes?: number;
  totalTtc: number;
  kwh: number;
  filePath?: string | null; // chemin storage (invoice-files) si un PDF est attaché
  previewUrl?: string | null; // URL signée pour la vignette (générée côté page)
  archived?: boolean;
  confidence?: number | null; // précision modèle moyenne (0-100), null si non disponible
  anomalies?: AnomalyLite[];
  anomalySeverity?: Severity | null;
}

/** Ligne de la vue invoice_analytics (jointures + total_kwh déjà agrégés en SQL). */
interface RawInvoice {
  id: string;
  facture_number: string | null;
  facture_date: string;
  total_ht: number | null;
  tva: number | null;
  autres_taxes: number | null;
  total_ttc: number | null;
  is_duplicata: boolean | null;
  categorie: "batiment" | "eclairage_public";
  file_path: string | null;
  archived: boolean | null;
  precision: Record<string, number> | null;
  total_kwh: number | null;
  site_nom: string | null;
  commune_nom: string | null;
  open_anomaly_count: number | null;
}

/** Clé de tri applicative → colonne de la vue. */
const SORT_COLUMN: Record<SortKey, string> = {
  date: "facture_date",
  number: "facture_number",
  site: "site_nom",
  commune: "commune_nom",
  kwh: "total_kwh",
  totalTtc: "total_ttc",
};

export interface InvoiceListPage {
  docs: InvoiceDoc[];
  /** KPIs calculés en SQL sur TOUT le périmètre filtré, pas seulement la page affichée. */
  kpis: InvoiceListKpis;
  page: number;
  pageSize: number;
  pageCount: number;
  isDemo?: boolean;
}

/** Confiance globale (0-100). Lit _global (score composite pondéré) si présent, sinon moyenne simple. */
function avgConfidence(precision: Record<string, number> | null): number | null {
  if (!precision) return null;
  if (typeof precision._global === "number") return Math.round(precision._global * 100);
  const vals = Object.values(precision).filter((v) => typeof v === "number");
  if (!vals.length) return null;
  return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 100);
}

// Exporté : consumption.ts pagine avec le même utilitaire — sans lui, ses SELECT
// étaient tronqués en silence à 1000 lignes (plafond PostgREST) et les analyses
// sous-comptaient dès ~300 factures.
export async function selectAll<T>(
  // PromiseLike : le query builder Supabase est un thenable (pas une Promise complète) ;
  // `unknown[]` évite le conflit entre les relations inférées (tableaux) et nos types Raw*.
  queryFactory: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>,
  pageSize = 1000,
): Promise<T[] | null> {
  const out: T[] = [];
  let start = 0;
  while (true) {
    const { data, error } = await queryFactory(start, start + pageSize - 1);
    if (error) return null;
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < pageSize) return out;
    start += pageSize;
  }
}

const LIST_COLUMNS =
  "id, facture_number, facture_date, total_ht, tva, autres_taxes, total_ttc, is_duplicata, categorie, file_path, archived, precision, total_kwh, site_nom, commune_nom, open_anomaly_count";

/** Anomalies des factures données, indexées par invoice_id. */
async function loadAnomalies(
  supabase: Awaited<ReturnType<typeof createClient>>,
  invoiceIds: string[],
): Promise<Map<string, AnomalyLite[]>> {
  const byInvoice = new Map<string, AnomalyLite[]>();
  if (invoiceIds.length === 0) return byInvoice;

  type RawAnomaly = { id: string; invoice_id: string; type: string; severity: string; description: string; resolved: boolean; detected_value: number | null };
  const rows = await selectAll<RawAnomaly>((from, to) =>
    supabase
      .from("anomalies")
      .select("id, invoice_id, type, severity, description, resolved, detected_value")
      .in("invoice_id", invoiceIds)
      .range(from, to),
  );

  // detected_value n'est en € que pour certains types (ttc_mismatch, cout_kwh) —
  // pour consumption_spike c'est un total en kWh : ne PAS l'exposer comme valueEur,
  // ça fausserait la somme du KPI "valeur détectée" du portefeuille.
  const EUR_VALUE_TYPES = new Set(["ttc_mismatch", "cout_kwh"]);
  for (const a of rows ?? []) {
    const sev: Severity = a.severity === "high" ? "high" : a.severity === "medium" ? "medium" : "low";
    const arr = byInvoice.get(a.invoice_id) ?? [];
    arr.push({
      id: a.id, type: a.type, severity: sev, message: a.description, resolved: !!a.resolved,
      valueEur: EUR_VALUE_TYPES.has(a.type) && a.detected_value != null ? Math.abs(a.detected_value) : undefined,
    });
    byInvoice.set(a.invoice_id, arr);
  }
  return byInvoice;
}

function toDoc(i: RawInvoice): InvoiceDoc {
  return {
    id: i.id,
    number: i.facture_number ?? "—",
    date: i.facture_date,
    site: i.site_nom ?? "—",
    commune: i.commune_nom ?? "—",
    categorie: i.categorie,
    isDuplicata: !!i.is_duplicata,
    totalHt: Number(i.total_ht ?? 0),
    tva: Number(i.tva ?? 0),
    autresTaxes: Number(i.autres_taxes ?? 0),
    totalTtc: Number(i.total_ttc ?? 0),
    kwh: Number(i.total_kwh ?? 0),
    filePath: i.file_path ?? null,
    archived: !!i.archived,
    confidence: avgConfidence(i.precision),
  };
}

/**
 * Une page de factures, filtrée/triée/paginée EN BASE.
 *
 * Les KPIs viennent d'un agrégat SQL sur l'ensemble du périmètre filtré, pas sur la page :
 * afficher le total TTC des seules 50 lignes visibles serait faux et trompeur.
 *
 * Pagination par offset (`.range()`) et non par curseur : elle seule permet « aller à la
 * page N » et l'affichage du nombre total, deux besoins réels pour parcourir un gros
 * portefeuille. Le coût de l'offset ne devient sensible qu'au-delà de ~50 000 lignes.
 */
export async function getInvoiceDocsPage(filters: InvoiceListFilters = {}): Promise<InvoiceListPage | null> {
  const ctx = await getUserContext();
  if (!ctx) return null;

  const supabase = await createClient();

  const pageSize = filters.pageSize ?? DEFAULT_PAGE_SIZE;
  const page = Math.max(1, filters.page ?? 1);
  const sortKey = filters.sort ?? "date";
  const ascending = filters.dir === "asc";
  const query = filters.query?.trim() ?? "";

  let q = supabase
    .from("invoice_analytics")
    .select(LIST_COLUMNS)
    .eq("org_id", ctx.orgId);

  if (!filters.showArchived) q = q.eq("archived", false);
  if (filters.categorie) q = q.eq("categorie", filters.categorie);
  if (filters.communeId) q = q.eq("commune_id", filters.communeId);
  if (filters.siteId) q = q.eq("site_id", filters.siteId);
  if (filters.onlyAnomalies) q = q.gt("open_anomaly_count", 0);
  if (filters.from) q = q.gte("facture_date", filters.from);
  if (filters.to) q = q.lte("facture_date", filters.to);
  if (query) {
    const escaped = query.replace(/[%,()]/g, " ");
    q = q.or(`facture_number.ilike.%${escaped}%,site_nom.ilike.%${escaped}%,commune_nom.ilike.%${escaped}%`);
  }

  const from = (page - 1) * pageSize;
  const [{ data, error }, kpiRes] = await Promise.all([
    q
      .order(SORT_COLUMN[sortKey], { ascending })
      // Départage stable : sans second critère, deux lignes de même date peuvent changer
      // d'ordre entre deux pages et apparaître en double / disparaître.
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1),
    // La plage de dates est passée au RPC : sans elle, les KPIs porteraient sur tout le
    // périmètre alors que la liste, elle, serait filtrée sur la période choisie.
    supabase.rpc("invoice_list_kpis", {
      p_query: query || null,
      p_categorie: filters.categorie ?? null,
      p_commune_id: filters.communeId ?? null,
      p_site_id: filters.siteId ?? null,
      p_only_anomalies: !!filters.onlyAnomalies,
      p_show_archived: !!filters.showArchived,
      p_from: filters.from ?? null,
      p_to: filters.to ?? null,
    }),
  ]);

  if (error) return null;

  const rows = (data ?? []) as unknown as RawInvoice[];
  const agg = (Array.isArray(kpiRes.data) ? kpiRes.data[0] : kpiRes.data) as {
    total_count: number; sum_total_ttc: number; sum_total_kwh: number;
    min_annee: number | null; max_annee: number | null;
    archived_count: number; anomaly_count: number;
  } | null;

  const total = Number(agg?.total_count ?? rows.length);
  const min = agg?.min_annee ?? null;
  const max = agg?.max_annee ?? null;

  const docs = rows.map(toDoc);
  const anomaliesByInvoice = await loadAnomalies(supabase, docs.map((d) => d.id));
  for (const d of docs) {
    d.anomalies = anomaliesByInvoice.get(d.id) ?? [];
    d.anomalySeverity = topSeverity(d.anomalies);
  }

  return {
    docs,
    kpis: {
      count: total,
      totalTtc: Number(agg?.sum_total_ttc ?? 0),
      totalKwh: Number(agg?.sum_total_kwh ?? 0),
      periode: min ? (min === max ? `${min}` : `${min}–${max}`) : "—",
      archivedCount: Number(agg?.archived_count ?? 0),
      anomalyCount: Number(agg?.anomaly_count ?? 0),
    },
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/**
 * Nombre de factures et total TTC par jour, pour la heatmap de la vue Calendrier.
 *
 * Agrégé en SQL et NON paginé : la liste, elle, l'est — un calendrier construit à partir de
 * la seule page affichée ne montrerait qu'une fraction des factures de l'année.
 *
 * La plage `from`/`to` est volontairement ignorée : le calendrier doit continuer à afficher
 * l'année entière une fois une période sélectionnée, sinon on ne pourrait plus en choisir
 * une autre. Les autres filtres (commune, site, catégorie…) sont eux appliqués.
 */
export async function getInvoiceCalendarDays(filters: InvoiceListFilters = {}): Promise<CalendarDay[]> {
  const ctx = await getUserContext();
  if (!ctx) return [];

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("invoice_calendar_days", {
    p_query: filters.query?.trim() || null,
    p_categorie: filters.categorie ?? null,
    p_commune_id: filters.communeId ?? null,
    p_site_id: filters.siteId ?? null,
    p_only_anomalies: !!filters.onlyAnomalies,
    p_show_archived: !!filters.showArchived,
  });

  if (error || !data) return [];
  return (data as { jour: string; n: number; total_ttc: number }[]).map((r) => ({
    date: r.jour,
    count: Number(r.n ?? 0),
    ttc: Number(r.total_ttc ?? 0),
  }));
}

/**
 * Factures portant au moins une anomalie — ouvertes OU résolues (page /anomalies).
 * Filtré en base via anomaly_count : inutile de charger tout le portefeuille pour
 * n'en garder ensuite qu'une poignée côté JS.
 *
 * `anomaly_count` (total) et non `open_anomaly_count` : filtrer sur les seules alertes
 * ouvertes faisait disparaître une facture — et tout son historique de résolutions —
 * dès que sa dernière alerte était résolue. L'onglet « Historique » ne montrait donc
 * que les résolutions des factures encore en alerte.
 */
export async function getInvoiceDocs(): Promise<InvoiceDoc[] | null> {
  const ctx = await getUserContext();
  if (!ctx) return null;

  const supabase = await createClient();

  const invoices = await selectAll<RawInvoice>((from, to) =>
    supabase
      .from("invoice_analytics")
      .select(LIST_COLUMNS)
      .eq("org_id", ctx.orgId)
      .eq("archived", false)
      .gt("anomaly_count", 0)
      .order("facture_date", { ascending: false })
      .range(from, to),
  );

  if (!invoices || invoices.length === 0) return null;

  const dbAnomaliesByInvoice = await loadAnomalies(supabase, invoices.map((i) => i.id));

  const docs: InvoiceDoc[] = invoices.map(toDoc);

  // Anomalies : source unique DB (persistées à l'insertion ou par le recalcul
  // portefeuille lib/anomalies/persist.ts — plus de recalcul/merge côté client).
  for (const d of docs) {
    d.anomalies = dbAnomaliesByInvoice.get(d.id) ?? [];
    d.anomalySeverity = topSeverity(d.anomalies);
  }

  return docs;
}

// `PortfolioPoint` / `getPortfolioScatter` ont été retirés avec le nuage « Montant vs
// consommation » de la page Anomalies. Ce graphique visualisait le portefeuille, pas les
// anomalies : un point qui « sortait du nuage » était simplement une grosse facture, et
// le coût unitaire — la seule information utile — n'y était lisible que comme une pente,
// ce que l'œil lit très mal. Le contexte de consommation est désormais fourni par
// lib/data/anomaly-context.ts, au niveau de chaque alerte.

/** Instantané des VRAIES factures (capturé via SQL) — repli pour le preview public. */
export const DEMO_INVOICE_DOCS: InvoiceDoc[] = [
  { id: "c4c3c28f", number: "SIM-237332-20240820", date: "2024-08-20", site: "Place Jules Pain", commune: "Fonds-Saint-Denis", categorie: "eclairage_public", isDuplicata: false, totalHt: 204.81, tva: 17.41, totalTtc: 229.99, kwh: 0 },
  { id: "a6961cdd", number: "SIM-301246-20240814", date: "2024-08-14", site: "École du bourg", commune: "Grand'Rivière", categorie: "batiment", isDuplicata: false, totalHt: 214.55, tva: 18.24, totalTtc: 248.59, kwh: 0 },
  { id: "17a53e96", number: "SIM-6003-20240812", date: "2024-08-12", site: "Écoles", commune: "Fonds-Saint-Denis", categorie: "batiment", isDuplicata: false, totalHt: 422.45, tva: 35.91, totalTtc: 489.13, kwh: 0 },
  { id: "cf3ea663", number: "SIM-6038-20240805", date: "2024-08-05", site: "Fonds Mascret", commune: "Fonds-Saint-Denis", categorie: "eclairage_public", isDuplicata: false, totalHt: 221.36, tva: 18.82, totalTtc: 257.6, kwh: 0 },
  { id: "a6793b95", number: "SIM-237329-20240218", date: "2024-02-18", site: "Podium", commune: "Fonds-Saint-Denis", categorie: "batiment", isDuplicata: false, totalHt: 456.47, tva: 38.8, totalTtc: 527.44, kwh: 0 },
  { id: "2d83617a", number: "SIM-5977-20240215", date: "2024-02-15", site: "La Croix", commune: "Fonds-Saint-Denis", categorie: "eclairage_public", isDuplicata: false, totalHt: 428.98, tva: 36.46, totalTtc: 495.85, kwh: 0 },
  { id: "22e71b9d", number: "SIM-301245-20240214", date: "2024-02-14", site: "Mairie", commune: "Grand'Rivière", categorie: "batiment", isDuplicata: false, totalHt: 255.52, tva: 21.72, totalTtc: 294.41, kwh: 0 },
  { id: "0fce74ba", number: "SIM-256273-20240212", date: "2024-02-12", site: "Hôtel de Ville", commune: "Fonds-Saint-Denis", categorie: "batiment", isDuplicata: false, totalHt: 366.88, tva: 31.18, totalTtc: 422.6, kwh: 0 },
  { id: "06d83d7f", number: "SIM-6061-20240210", date: "2024-02-10", site: "Bel Oncle", commune: "Fonds-Saint-Denis", categorie: "eclairage_public", isDuplicata: false, totalHt: 149.3, tva: 12.69, totalTtc: 171.89, kwh: 0 },
  { id: "d25ff629", number: "SIM-301250-20230810", date: "2023-08-10", site: "Bourg", commune: "Grand'Rivière", categorie: "eclairage_public", isDuplicata: false, totalHt: 132.51, tva: 11.26, totalTtc: 153.68, kwh: 0 },
  { id: "53a9c681", number: "13182184E", date: "2023-08-04", site: "Route de l'Observatoire", commune: "Fonds-Saint-Denis", categorie: "eclairage_public", isDuplicata: true, totalHt: 789.21, tva: 24.91, totalTtc: 911.59, kwh: 1694 },
  { id: "6de311ec", number: "SIM-301251-20230210", date: "2023-02-10", site: "Anse Céron", commune: "Grand'Rivière", categorie: "eclairage_public", isDuplicata: false, totalHt: 151.06, tva: 12.84, totalTtc: 174.12, kwh: 0 },
  { id: "b61517a0", number: "12634845E", date: "2023-02-06", site: "Bel Oncle", commune: "Fonds-Saint-Denis", categorie: "eclairage_public", isDuplicata: true, totalHt: 636.93, tva: 28.6, totalTtc: 746.52, kwh: 3340 },
  { id: "e34cf886", number: "SIM-301250-20220810", date: "2022-08-10", site: "Bourg", commune: "Grand'Rivière", categorie: "eclairage_public", isDuplicata: false, totalHt: 284.19, tva: 24.16, totalTtc: 331.02, kwh: 0 },
  { id: "1e746d9a", number: "10641872E", date: "2021-02-24", site: "Place Jules Pain", commune: "Fonds-Saint-Denis", categorie: "eclairage_public", isDuplicata: true, totalHt: 168.99, tva: 9.14, totalTtc: 224.44, kwh: 516 },
  { id: "530a7f0c", number: "8645375E", date: "2019-02-05", site: "Morne des Cadets", commune: "Fonds-Saint-Denis", categorie: "eclairage_public", isDuplicata: true, totalHt: 472.54, tva: 34.29, totalTtc: 680.5, kwh: 3299 },
  { id: "08079f28", number: "8186002E", date: "2018-08-14", site: "Fonds Mascret", commune: "Fonds-Saint-Denis", categorie: "eclairage_public", isDuplicata: true, totalHt: 957.84, tva: 99.21, totalTtc: 1501.73, kwh: 10944 },
  { id: "eaaab74a", number: "7267537E", date: "2017-08-31", site: "La Croix", commune: "Fonds-Saint-Denis", categorie: "eclairage_public", isDuplicata: true, totalHt: 1199.87, tva: 104.19, totalTtc: 1784.85, kwh: 10563 },
];
