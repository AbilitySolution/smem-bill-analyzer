import { NextResponse } from "next/server";
import { getUserContext } from "@/lib/auth";
import { getInvoiceDocsPage, type SortKey, type InvoiceListFilters } from "@/lib/data/invoices";

const SORT_KEYS: SortKey[] = ["date", "number", "site", "commune", "kwh", "totalTtc"];

/** Garde-fou : au-delà, l'export passerait par un job asynchrone plutôt qu'une réponse HTTP. */
const MAX_ROWS = 20_000;

const catLabel = (c: string) => (c === "batiment" ? "Bâtiment" : "Éclairage public");
const frDate = (d: string) => { const [y, m, j] = d.split("-"); return `${j}/${m}/${y}`; };

/** Échappement CSV : guillemets doublés, champ cité dès qu'il contient ; " ou saut de ligne. */
function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Export CSV de l'ENSEMBLE du périmètre filtré (pas de la page affichée).
 * Reprend exactement les paramètres d'URL du hub, pour que l'export corresponde toujours
 * à ce que l'utilisateur voit à l'écran.
 */
export async function GET(request: Request) {
  const ctx = await getUserContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = new URL(request.url).searchParams;
  const cat = sp.get("cat");
  const sort = SORT_KEYS.includes(sp.get("sort") as SortKey) ? (sp.get("sort") as SortKey) : "date";

  const filters: Omit<InvoiceListFilters, "page" | "pageSize"> = {
    query: sp.get("q") ?? undefined,
    categorie: cat === "batiment" || cat === "eclairage_public" ? cat : undefined,
    communeId: sp.get("commune") ?? undefined,
    siteId: sp.get("site") ?? undefined,
    onlyAnomalies: sp.get("anomalies") === "1",
    showArchived: sp.get("archived") === "1",
    sort,
    dir: (sp.get("dir") === "asc" ? "asc" : "desc") as "asc" | "desc",
  };

  // Première page pour connaître le total, puis on rapatrie tout le périmètre.
  const head = await getInvoiceDocsPage({ ...filters, page: 1, pageSize: 1 });
  if (!head) return NextResponse.json({ error: "Aucune donnée." }, { status: 404 });

  const total = Math.min(head.kpis.count, MAX_ROWS);
  const rows: string[] = [
    ["N° facture", "Date", "Site", "Commune", "Catégorie", "Duplicata", "Total HT (€)", "TVA (€)", "Total TTC (€)", "Conso (kWh)", "Anomalies ouvertes"]
      .map(cell).join(";"),
  ];

  const chunk = 1000;
  for (let page = 1; (page - 1) * chunk < total; page++) {
    const res = await getInvoiceDocsPage({ ...filters, page, pageSize: chunk });
    if (!res || res.docs.length === 0) break;
    for (const d of res.docs) {
      rows.push([
        d.number, frDate(d.date), d.site, d.commune, catLabel(d.categorie),
        d.isDuplicata ? "Oui" : "Non",
        d.totalHt, d.tva, d.totalTtc, d.kwh,
        (d.anomalies ?? []).filter((a) => !a.resolved).length,
      ].map(cell).join(";"));
    }
  }

  // BOM UTF-8 : sans lui Excel (Windows) lit les accents de travers.
  const body = "﻿" + rows.join("\r\n");
  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="factures-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
