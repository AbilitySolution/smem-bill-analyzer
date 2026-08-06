import { DocumentsHub } from "@/components/documents/documents-hub";
import {
  getInvoiceDocsPage, getInvoiceCalendarDays, DEMO_INVOICE_DOCS, PAGE_SIZES, DEFAULT_PAGE_SIZE,
  type InvoiceDoc, type InvoiceListPage, type SortKey,
} from "@/lib/data/invoices";
import { getUserContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const SORT_KEYS: SortKey[] = ["date", "number", "site", "commune", "kwh", "totalTtc"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const asDate = (v?: string) => (v && DATE_RE.test(v) ? v : undefined);

interface SearchParams {
  q?: string; cat?: string; commune?: string; site?: string;
  anomalies?: string; archived?: string; from?: string; to?: string;
  sort?: string; dir?: string; page?: string; size?: string;
}

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;

  const cat = sp.cat === "batiment" || sp.cat === "eclairage_public" ? sp.cat : undefined;
  const sort = SORT_KEYS.includes(sp.sort as SortKey) ? (sp.sort as SortKey) : "date";
  const dir = sp.dir === "asc" ? "asc" : "desc";
  const size = PAGE_SIZES.includes(Number(sp.size) as (typeof PAGE_SIZES)[number])
    ? Number(sp.size) : DEFAULT_PAGE_SIZE;

  // Bornes inversées dans l'URL → on rétablit l'ordre plutôt que de renvoyer un ensemble vide.
  let from = asDate(sp.from);
  let to = asDate(sp.to);
  if (from && to && from > to) [from, to] = [to, from];

  const filters = {
    query: sp.q,
    categorie: cat,
    communeId: sp.commune || undefined,
    siteId: sp.site || undefined,
    onlyAnomalies: sp.anomalies === "1",
    showArchived: sp.archived === "1",
    from, to,
    sort, dir,
    page: Math.max(1, Number(sp.page) || 1),
    pageSize: size,
  } as const;

  const ctx = await getUserContext();

  // Hors session (aperçu public) : jeu de démo, aucune requête réelle (RLS renverrait vide).
  if (!ctx) {
    return (
      <DocumentsHub
        result={demoPage(filters.pageSize)}
        communes={[]}
        sites={[]}
        filters={filters}
        calendarDays={demoCalendarDays()}
      />
    );
  }

  const supabase = await createClient();
  const [result, communesRes, sitesRes, calendarDays] = await Promise.all([
    getInvoiceDocsPage(filters),
    supabase.from("communes").select("id, nom").eq("org_id", ctx.orgId).order("nom"),
    supabase.from("sites").select("id, nom, commune_id").eq("org_id", ctx.orgId).order("nom"),
    getInvoiceCalendarDays(filters),
  ]);

  const page = result ?? emptyPage(filters.page, filters.pageSize);

  return (
    <DocumentsHub
      result={{ ...page, docs: await attachPreviews(page.docs) }}
      communes={communesRes.data ?? []}
      sites={sitesRes.data ?? []}
      filters={filters}
      calendarDays={calendarDays}
    />
  );
}

function emptyPage(page: number, pageSize: number): InvoiceListPage {
  return {
    docs: [],
    kpis: { count: 0, totalTtc: 0, totalKwh: 0, periode: "—", archivedCount: 0, anomalyCount: 0 },
    page, pageSize, pageCount: 1,
  };
}

function demoPage(pageSize: number): InvoiceListPage {
  const docs = DEMO_INVOICE_DOCS.slice(0, pageSize);
  return {
    docs,
    kpis: {
      count: DEMO_INVOICE_DOCS.length,
      totalTtc: DEMO_INVOICE_DOCS.reduce((s, d) => s + d.totalTtc, 0),
      totalKwh: DEMO_INVOICE_DOCS.reduce((s, d) => s + d.kwh, 0),
      periode: "2024",
      archivedCount: 0,
      anomalyCount: 0,
    },
    page: 1,
    pageSize,
    pageCount: Math.max(1, Math.ceil(DEMO_INVOICE_DOCS.length / pageSize)),
    isDemo: true,
  };
}

/** Agrégat par jour du jeu de démo — sans lui le calendrier serait vide en aperçu public. */
function demoCalendarDays() {
  const map = new Map<string, { count: number; ttc: number }>();
  for (const d of DEMO_INVOICE_DOCS) {
    const cur = map.get(d.date) ?? { count: 0, ttc: 0 };
    cur.count += 1;
    cur.ttc += d.totalTtc;
    map.set(d.date, cur);
  }
  return [...map.entries()]
    .map(([date, v]) => ({ date, count: v.count, ttc: v.ttc }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Génère en lot les URLs signées des PDF pour les vignettes (galerie / aperçu). */
async function attachPreviews(docs: InvoiceDoc[]): Promise<InvoiceDoc[]> {
  // Les factures simulées portent un file_path sentinelle `seed-sim/…` sans fichier réel :
  // inutile de demander des URLs signées pour elles.
  const paths = docs.map((d) => d.filePath).filter((p): p is string => !!p && !p.startsWith("seed-sim/"));
  if (!paths.length) return docs;
  try {
    const supabase = await createClient();
    const { data } = await supabase.storage.from("invoice-files").createSignedUrls(paths, 3600);
    const byPath = new Map((data ?? []).filter((s) => s.signedUrl).map((s) => [s.path, s.signedUrl]));
    return docs.map((d) => (d.filePath ? { ...d, previewUrl: byPath.get(d.filePath) ?? null } : d));
  } catch {
    return docs;
  }
}
