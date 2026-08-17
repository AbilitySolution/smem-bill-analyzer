import { createClient } from "@/lib/supabase/server";

/** Une facture avec sa période de facturation couverte [spanStart, spanEnd]. */
export interface CoverageInvoice {
  id: string;
  factureNumber: string;
  factureDate: string;
  totalTtc: number;
  siteId: string;
  siteNom: string;
  communeId: string;
  communeNom: string;
  spanStart: string; // "YYYY-MM-DD"
  spanEnd: string;
}

export interface CoverageData {
  invoices: CoverageInvoice[];
  communes: { id: string; nom: string }[];
  sites: { id: string; nom: string; communeId: string }[];
  isDemo?: boolean;
}

export interface CoverageFilters {
  orgId: string;
}

interface RawInv {
  id: string;
  facture_number: string | null;
  facture_date: string;
  total_ttc: number | null;
  site_id: string | null;
  commune_id: string | null;
  sites: { nom: string } | null;
  communes: { nom: string } | null;
}

/** Couverture de facturation : période [min(period_start), max(period_end)] par facture, pour la
 *  heatmap couverture (site/commune × période). Repli sur la date de facture si aucune période. */
export async function getCoverageData(filters: CoverageFilters): Promise<CoverageData | null> {
  const supabase = await createClient();

  // org_id explicite en plus de la RLS (défense en profondeur).
  //
  // Les communes et les sites sont chargés depuis leurs tables, PAS dérivés des factures
  // (§3.1 du PLAN) : une commune fraîchement créée n'a par définition aucune facture, et
  // se serait donc affichée nulle part — la fonctionnalité aurait semblé ne pas marcher.
  // Le rapprochement avec les agrégats de factures se fait ensuite, en left join logique.
  const [invRes, perRes, commRes, siteRes] = await Promise.all([
    supabase
      .from("invoices")
      .select("id, facture_number, facture_date, total_ttc, site_id, commune_id, sites(nom), communes(nom)")
      .eq("org_id", filters.orgId)
      .eq("archived", false)
      .not("site_id", "is", null),
    supabase
      .from("consumption_periods")
      .select("invoice_id, period_start, period_end, invoices!inner(org_id)")
      .eq("invoices.org_id", filters.orgId),
    supabase
      .from("communes")
      .select("id, nom")
      .eq("org_id", filters.orgId)
      .eq("archived", false),
    supabase
      .from("sites")
      .select("id, nom, commune_id")
      .eq("org_id", filters.orgId),
  ]);

  // Une organisation sans aucune commune n'a rien à afficher. En revanche des communes
  // sans la moindre facture, si : elles apparaissent à zéro.
  if (commRes.error || !commRes.data || commRes.data.length === 0) return null;
  if (invRes.error) return null;

  // Span par facture : [min(period_start), max(period_end)] sur ses lignes de conso.
  const span = new Map<string, { start: string; end: string }>();
  for (const p of (perRes.data ?? []) as { invoice_id: string; period_start: string | null; period_end: string | null }[]) {
    if (!p.period_start || !p.period_end) continue;
    const cur = span.get(p.invoice_id);
    if (!cur) span.set(p.invoice_id, { start: p.period_start, end: p.period_end });
    else {
      if (p.period_start < cur.start) cur.start = p.period_start;
      if (p.period_end > cur.end) cur.end = p.period_end;
    }
  }

  const invoices: CoverageInvoice[] = [];

  // Le référentiel de l'organisation d'abord : toutes les communes actives et tous leurs
  // sites, factures ou pas. Les factures ne font qu'alimenter les cases de la heatmap.
  const communesMap = new Map<string, string>(
    (commRes.data as Array<{ id: string; nom: string }>).map((c) => [c.id, c.nom]),
  );
  const sitesMap = new Map<string, { nom: string; communeId: string }>(
    (siteRes.data ?? [])
      .filter((s) => s.commune_id && communesMap.has(s.commune_id))
      .map((s) => [s.id as string, { nom: s.nom as string, communeId: s.commune_id as string }]),
  );

  for (const i of (invRes.data ?? []) as unknown as RawInv[]) {
    if (!i.site_id || !i.commune_id) continue;
    // Facture rattachée à une commune archivée : on ne la fait pas réapparaître dans la
    // vue par la bande. La commune a été retirée, ses factures le suivent.
    const communeNom = communesMap.get(i.commune_id);
    if (communeNom === undefined) continue;

    const s = span.get(i.id);
    // Repli : facture sans période détaillée → span ponctuel = date de facture.
    const spanStart = s?.start ?? i.facture_date;
    const spanEnd = s?.end ?? i.facture_date;
    const siteNom = i.sites?.nom ?? "—";
    // Le site vient normalement de sitesMap ; on complète au cas où il aurait échappé à
    // la requête (site d'une autre org filtré par RLS, par exemple).
    if (!sitesMap.has(i.site_id)) {
      sitesMap.set(i.site_id, { nom: siteNom, communeId: i.commune_id });
    }
    invoices.push({
      id: i.id,
      factureNumber: i.facture_number ?? "—",
      factureDate: i.facture_date,
      totalTtc: Number(i.total_ttc ?? 0),
      siteId: i.site_id,
      siteNom,
      communeId: i.commune_id,
      communeNom,
      spanStart,
      spanEnd,
    });
  }

  return {
    invoices,
    communes: [...communesMap.entries()].map(([id, nom]) => ({ id, nom })).sort((a, b) => a.nom.localeCompare(b.nom)),
    sites: [...sitesMap.entries()].map(([id, s]) => ({ id, nom: s.nom, communeId: s.communeId })).sort((a, b) => a.nom.localeCompare(b.nom)),
  };
}

/** Repli de démonstration (hors session / RLS). */
export const DEMO_COVERAGE: CoverageData = {
  isDemo: true,
  communes: [
    { id: "c1", nom: "Fonds-Saint-Denis" },
    { id: "c2", nom: "Le Carbet" },
  ],
  sites: [
    { id: "s1", nom: "Place Jules Pain", communeId: "c1" },
    { id: "s2", nom: "La Croix", communeId: "c1" },
    { id: "s3", nom: "Morne des Cadets", communeId: "c1" },
    { id: "s4", nom: "Bourg", communeId: "c2" },
    { id: "s5", nom: "Morne aux Bœufs", communeId: "c2" },
  ],
  invoices: [
    { id: "i1", factureNumber: "F-2021-01", factureDate: "2021-03-10", totalTtc: 224, siteId: "s1", siteNom: "Place Jules Pain", communeId: "c1", communeNom: "Fonds-Saint-Denis", spanStart: "2021-01-01", spanEnd: "2021-06-30" },
    { id: "i2", factureNumber: "F-2023-11", factureDate: "2023-12-01", totalTtc: 911, siteId: "s1", siteNom: "Place Jules Pain", communeId: "c1", communeNom: "Fonds-Saint-Denis", spanStart: "2021-01-01", spanEnd: "2023-12-31" },
    { id: "i3", factureNumber: "F-2017-08", factureDate: "2017-08-31", totalTtc: 1784, siteId: "s2", siteNom: "La Croix", communeId: "c1", communeNom: "Fonds-Saint-Denis", spanStart: "2017-01-01", spanEnd: "2017-08-31" },
    { id: "i4", factureNumber: "F-2019-02", factureDate: "2019-02-05", totalTtc: 680, siteId: "s3", siteNom: "Morne des Cadets", communeId: "c1", communeNom: "Fonds-Saint-Denis", spanStart: "2018-07-01", spanEnd: "2019-02-05" },
    { id: "i5", factureNumber: "F-2023-06", factureDate: "2023-06-10", totalTtc: 153, siteId: "s4", siteNom: "Bourg", communeId: "c2", communeNom: "Le Carbet", spanStart: "2023-01-01", spanEnd: "2023-06-30" },
    { id: "i6", factureNumber: "F-2024-06", factureDate: "2024-06-10", totalTtc: 172, siteId: "s5", siteNom: "Morne aux Bœufs", communeId: "c2", communeNom: "Le Carbet", spanStart: "2024-01-01", spanEnd: "2024-06-30" },
  ],
};
