import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { createClient } from "@/lib/supabase/server";
import { classifyTarif } from "@/lib/data/consumption";

export const runtime = "nodejs";

const ORANGE = "FFF97316";
const ORANGE_DARK = "FFEA580C";
const SOFT = "FFFFEDD5";

const EUR = '#,##0.00" €"';
const KWH = '#,##0" kWh"';
const CENTS = '0.00" c€"';

interface ExportBody {
  ids?: string[];
  from?: string;
  to?: string;
  communeIds?: string[];
  siteIds?: string[];
  categorie?: "batiment" | "eclairage_public";
  includeDuplicatas?: boolean;
  sheets?: string[];
  filename?: string;
}

type Num = number | string | null;
const n = (v: Num) => Number(v ?? 0);

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as ExportBody;
  const sheets = new Set(body.sheets?.length ? body.sheets : ["synthese", "factures", "consommation", "communes", "postes", "taxes"]);

  // ---- Périmètre : factures ----
  let q = supabase
    .from("invoices")
    .select("id, facture_number, facture_date, total_ht, tva, autres_taxes, total_ttc, is_duplicata, categorie, status, site_id, commune_id, sites(nom, pdl), communes(nom)")
    .eq("archived", false)
    .order("facture_date", { ascending: true });

  if (body.ids?.length) {
    q = q.in("id", body.ids);
  } else {
    if (body.from) q = q.gte("facture_date", body.from);
    if (body.to) q = q.lte("facture_date", body.to);
    if (body.communeIds?.length) q = q.in("commune_id", body.communeIds);
    if (body.siteIds?.length) q = q.in("site_id", body.siteIds);
    if (body.categorie) q = q.eq("categorie", body.categorie);
    if (body.includeDuplicatas === false) q = q.eq("is_duplicata", false);
  }

  const { data: invRows, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Inv = {
    id: string; facture_number: string | null; facture_date: string | null;
    total_ht: Num; tva: Num; autres_taxes: Num; total_ttc: Num;
    is_duplicata: boolean | null; categorie: string; status: string | null;
    sites: { nom: string; pdl: string | null } | null; communes: { nom: string } | null;
  };
  const invoices = (invRows ?? []) as unknown as Inv[];
  const ids = invoices.map((i) => i.id);

  // ---- Lignes liées ----
  const [{ data: periodsRaw }, { data: chargesRaw }] = await Promise.all([
    ids.length ? supabase.from("consumption_periods").select("invoice_id, poste_tarifaire, period_start, period_end, consommation_kwh, prix_unitaire_ckwh, montant_eur").in("invoice_id", ids) : Promise.resolve({ data: [] }),
    ids.length ? supabase.from("invoice_charges").select("invoice_id, category, libelle, period_start, period_end, assiette, taux, montant_eur").in("invoice_id", ids) : Promise.resolve({ data: [] }),
  ]);
  const periods = (periodsRaw ?? []) as Record<string, Num | string | null>[];
  const charges = (chargesRaw ?? []) as Record<string, Num | string | null>[];

  const invById = new Map(invoices.map((i) => [i.id, i]));
  const kwhByInvoice = new Map<string, number>();
  for (const p of periods) {
    const k = String(p.invoice_id);
    kwhByInvoice.set(k, (kwhByInvoice.get(k) ?? 0) + n(p.consommation_kwh as Num));
  }

  // ---- Workbook ----
  const wb = new ExcelJS.Workbook();
  wb.creator = "Ability";
  wb.created = new Date();

  const styleHeaderRow = (ws: ExcelJS.Worksheet, rowNumber = 1) => {
    const row = ws.getRow(rowNumber);
    row.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ORANGE } };
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      cell.alignment = { vertical: "middle" };
      cell.border = { bottom: { style: "thin", color: { argb: ORANGE_DARK } } };
    });
    row.height = 20;
  };

  const frDate = (d: Num | string | null) => {
    if (!d) return "";
    const [y, m, j] = String(d).split("-");
    return j ? `${j}/${m}/${y}` : String(d);
  };

  const periodLabel = body.ids?.length
    ? `${invoices.length} facture(s) présélectionnée(s)`
    : `${body.from ? frDate(body.from) : "début"} → ${body.to ? frDate(body.to) : "aujourd'hui"}`;

  // === Feuille Synthèse ===
  if (sheets.has("synthese")) {
    const ws = wb.addWorksheet("Synthèse", { properties: { defaultColWidth: 22 } });
    ws.mergeCells("A1:C1");
    ws.getCell("A1").value = "Ability — Rapport de factures d'électricité";
    ws.getCell("A1").font = { bold: true, size: 14, color: { argb: ORANGE_DARK } };
    ws.getCell("A2").value = `Périmètre : ${periodLabel}`;
    ws.getCell("A2").font = { italic: true, color: { argb: "FF6B7280" } };

    const totHt = invoices.reduce((s, i) => s + n(i.total_ht), 0);
    const totTva = invoices.reduce((s, i) => s + n(i.tva), 0);
    const totTtc = invoices.reduce((s, i) => s + n(i.total_ttc), 0);
    const totKwh = [...kwhByInvoice.values()].reduce((s, v) => s + v, 0);
    const totMontant = periods.reduce((s, p) => s + n(p.montant_eur as Num), 0);
    const avgPx = totKwh ? (totMontant / totKwh) * 100 : 0;

    const kpis: [string, number, string][] = [
      ["Nombre de factures", invoices.length, "0"],
      ["Total HT", totHt, EUR],
      ["TVA", totTva, EUR],
      ["Total TTC", totTtc, EUR],
      ["Consommation totale", totKwh, KWH],
      ["Prix moyen", avgPx, CENTS],
    ];
    let r = 4;
    for (const [label, value, fmt] of kpis) {
      ws.getCell(`A${r}`).value = label;
      ws.getCell(`A${r}`).font = { bold: true };
      const c = ws.getCell(`B${r}`);
      c.value = value; c.numFmt = fmt;
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: SOFT } };
      r++;
    }

    // Récap par commune
    r += 1;
    ws.getCell(`A${r}`).value = "Récapitulatif par commune";
    ws.getCell(`A${r}`).font = { bold: true, size: 12, color: { argb: ORANGE_DARK } };
    r++;
    const headerRow = r;
    ws.getRow(r).values = ["Commune", "Factures", "Consommation", "Total TTC"];
    styleHeaderRow(ws, r);
    r++;
    const byCommune = new Map<string, { count: number; kwh: number; ttc: number }>();
    for (const i of invoices) {
      const key = i.communes?.nom ?? "—";
      const cur = byCommune.get(key) ?? { count: 0, kwh: 0, ttc: 0 };
      cur.count++; cur.ttc += n(i.total_ttc); cur.kwh += kwhByInvoice.get(i.id) ?? 0;
      byCommune.set(key, cur);
    }
    for (const [commune, v] of [...byCommune.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      ws.getRow(r).values = [commune, v.count, v.kwh, v.ttc];
      ws.getCell(`C${r}`).numFmt = KWH;
      ws.getCell(`D${r}`).numFmt = EUR;
      r++;
    }
    ws.getColumn(1).width = 26;
    ws.views = [{ state: "frozen", ySplit: headerRow }];
  }

  // === Feuille Factures ===
  if (sheets.has("factures")) {
    const ws = wb.addWorksheet("Factures");
    ws.columns = [
      { header: "N° facture", key: "num", width: 16 },
      { header: "Date", key: "date", width: 12 },
      { header: "Commune", key: "commune", width: 18 },
      { header: "Site", key: "site", width: 22 },
      { header: "Catégorie", key: "cat", width: 16 },
      { header: "PDL", key: "pdl", width: 12 },
      { header: "Duplicata", key: "dup", width: 10 },
      { header: "Total HT", key: "ht", width: 13, style: { numFmt: EUR } },
      { header: "TVA", key: "tva", width: 12, style: { numFmt: EUR } },
      { header: "Autres taxes", key: "tax", width: 13, style: { numFmt: EUR } },
      { header: "Total TTC", key: "ttc", width: 13, style: { numFmt: EUR } },
      { header: "Consommation", key: "kwh", width: 14, style: { numFmt: KWH } },
      { header: "Statut", key: "status", width: 12 },
    ];
    for (const i of invoices) {
      ws.addRow({
        num: i.facture_number ?? "—",
        date: frDate(i.facture_date),
        commune: i.communes?.nom ?? "—",
        site: i.sites?.nom ?? "—",
        cat: i.categorie === "batiment" ? "Bâtiment" : "Éclairage public",
        pdl: i.sites?.pdl ?? "",
        dup: i.is_duplicata ? "Oui" : "Non",
        ht: n(i.total_ht), tva: n(i.tva), tax: n(i.autres_taxes), ttc: n(i.total_ttc),
        kwh: kwhByInvoice.get(i.id) ?? 0,
        status: i.status ?? "",
      });
    }
    styleHeaderRow(ws);
    ws.autoFilter = "A1:M1";
    ws.views = [{ state: "frozen", ySplit: 1 }];
  }

  // === Feuille Consommation détaillée ===
  if (sheets.has("consommation")) {
    const ws = wb.addWorksheet("Consommation détaillée");
    ws.columns = [
      { header: "N° facture", key: "num", width: 16 },
      { header: "Commune", key: "commune", width: 18 },
      { header: "Site", key: "site", width: 22 },
      { header: "Poste", key: "poste", width: 16 },
      { header: "Période début", key: "start", width: 14 },
      { header: "Période fin", key: "end", width: 14 },
      { header: "Consommation", key: "kwh", width: 14, style: { numFmt: KWH } },
      { header: "Prix unitaire", key: "px", width: 13, style: { numFmt: CENTS } },
      { header: "Montant", key: "montant", width: 13, style: { numFmt: EUR } },
    ];
    for (const p of periods) {
      const inv = invById.get(String(p.invoice_id));
      const tarif = classifyTarif(String(p.poste_tarifaire ?? ""));
      ws.addRow({
        num: inv?.facture_number ?? "—",
        commune: inv?.communes?.nom ?? "—",
        site: inv?.sites?.nom ?? "—",
        poste: `${tarif}${p.poste_tarifaire ? ` (${p.poste_tarifaire})` : ""}`,
        start: frDate(p.period_start as Num), end: frDate(p.period_end as Num),
        kwh: n(p.consommation_kwh as Num),
        px: p.prix_unitaire_ckwh != null ? n(p.prix_unitaire_ckwh as Num) : null,
        montant: n(p.montant_eur as Num),
      });
    }
    styleHeaderRow(ws);
    ws.autoFilter = "A1:I1";
    ws.views = [{ state: "frozen", ySplit: 1 }];
  }

  // === Feuille Par commune ===
  if (sheets.has("communes")) {
    const ws = wb.addWorksheet("Par commune");
    ws.columns = [
      { header: "Commune", key: "commune", width: 22 },
      { header: "Nb sites", key: "sites", width: 10 },
      { header: "Nb factures", key: "count", width: 12 },
      { header: "Consommation", key: "kwh", width: 14, style: { numFmt: KWH } },
      { header: "Total TTC", key: "ttc", width: 14, style: { numFmt: EUR } },
      { header: "Prix moyen", key: "px", width: 13, style: { numFmt: CENTS } },
    ];
    const agg = new Map<string, { sites: Set<string>; count: number; kwh: number; ttc: number; montant: number }>();
    for (const i of invoices) {
      const key = i.communes?.nom ?? "—";
      const cur = agg.get(key) ?? { sites: new Set(), count: 0, kwh: 0, ttc: 0, montant: 0 };
      cur.count++; cur.ttc += n(i.total_ttc); cur.kwh += kwhByInvoice.get(i.id) ?? 0;
      if (i.sites?.nom) cur.sites.add(i.sites.nom);
      agg.set(key, cur);
    }
    for (const p of periods) {
      const inv = invById.get(String(p.invoice_id));
      const key = inv?.communes?.nom ?? "—";
      const cur = agg.get(key); if (cur) cur.montant += n(p.montant_eur as Num);
    }
    for (const [commune, v] of [...agg.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      ws.addRow({ commune, sites: v.sites.size, count: v.count, kwh: v.kwh, ttc: v.ttc, px: v.kwh ? (v.montant / v.kwh) * 100 : null });
    }
    styleHeaderRow(ws);
    ws.views = [{ state: "frozen", ySplit: 1 }];
  }

  // === Feuille Par poste HP/HC/Base ===
  if (sheets.has("postes")) {
    const ws = wb.addWorksheet("Par poste");
    ws.columns = [
      { header: "Poste tarifaire", key: "poste", width: 18 },
      { header: "Consommation", key: "kwh", width: 14, style: { numFmt: KWH } },
      { header: "Montant", key: "montant", width: 14, style: { numFmt: EUR } },
      { header: "Prix moyen", key: "px", width: 13, style: { numFmt: CENTS } },
      { header: "Part conso", key: "part", width: 12, style: { numFmt: '0.0"%"' } },
    ];
    const agg: Record<string, { kwh: number; montant: number }> = { HP: { kwh: 0, montant: 0 }, HC: { kwh: 0, montant: 0 }, Base: { kwh: 0, montant: 0 } };
    for (const p of periods) {
      const t = classifyTarif(String(p.poste_tarifaire ?? ""));
      agg[t].kwh += n(p.consommation_kwh as Num);
      agg[t].montant += n(p.montant_eur as Num);
    }
    const totalKwh = agg.HP.kwh + agg.HC.kwh + agg.Base.kwh;
    for (const poste of ["HP", "HC", "Base"] as const) {
      const v = agg[poste];
      if (v.kwh === 0 && v.montant === 0) continue;
      ws.addRow({
        poste: poste === "HP" ? "Heures pleines (HP)" : poste === "HC" ? "Heures creuses (HC)" : "Base",
        kwh: v.kwh, montant: v.montant,
        px: v.kwh ? (v.montant / v.kwh) * 100 : null,
        part: totalKwh ? (v.kwh / totalKwh) * 100 : 0,
      });
    }
    styleHeaderRow(ws);
    ws.views = [{ state: "frozen", ySplit: 1 }];
  }

  // === Feuille Taxes & charges ===
  if (sheets.has("taxes")) {
    const ws = wb.addWorksheet("Taxes & charges");
    ws.columns = [
      { header: "N° facture", key: "num", width: 16 },
      { header: "Commune", key: "commune", width: 18 },
      { header: "Type", key: "type", width: 12 },
      { header: "Libellé", key: "libelle", width: 30 },
      { header: "Période début", key: "start", width: 14 },
      { header: "Période fin", key: "end", width: 14 },
      { header: "Assiette", key: "assiette", width: 12 },
      { header: "Taux", key: "taux", width: 12 },
      { header: "Montant", key: "montant", width: 13, style: { numFmt: EUR } },
    ];
    for (const c of charges) {
      const inv = invById.get(String(c.invoice_id));
      ws.addRow({
        num: inv?.facture_number ?? "—",
        commune: inv?.communes?.nom ?? "—",
        type: c.category === "tax" ? "Taxe" : c.category === "fixed" ? "Part fixe" : String(c.category ?? ""),
        libelle: c.libelle ?? "",
        start: frDate(c.period_start as Num), end: frDate(c.period_end as Num),
        assiette: c.assiette != null ? n(c.assiette as Num) : null,
        taux: c.taux ?? "",
        montant: n(c.montant_eur as Num),
      });
    }
    styleHeaderRow(ws);
    ws.autoFilter = "A1:I1";
    ws.views = [{ state: "frozen", ySplit: 1 }];
  }

  const buffer = await wb.xlsx.writeBuffer();
  const filename = (body.filename?.trim() || "rapport-ability").replace(/[^a-zA-Z0-9_-]/g, "_") + ".xlsx";

  return new NextResponse(buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
