import { createClient } from "@/lib/supabase/server";
import { getUserContext } from "@/lib/auth";
import { detectAnomalies, topSeverity, median, costPerKwh, type AnomalyLite, type Severity } from "./anomalies";

export interface InvoiceLine {
  poste: string;
  periode: string;
  kwh: number;
  prix: number | null; // c€/kWh
  montant: number; // €
}

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
  lines: InvoiceLine[];
  filePath?: string | null; // chemin storage (invoice-files) si un PDF est attaché
  previewUrl?: string | null; // URL signée pour la vignette (générée côté page)
  archived?: boolean;
  confidence?: number | null; // précision modèle moyenne (0-100), null si non disponible
  anomalies?: AnomalyLite[];
  anomalySeverity?: Severity | null;
}

function periodeLabel(start?: string | null, end?: string | null): string {
  const f = (d?: string | null) => {
    if (!d) return "?";
    const [y, m] = d.split("-");
    return `${m}/${y.slice(2)}`;
  };
  if (!start && !end) return "—";
  return `${f(start)} → ${f(end)}`;
}

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
  sites: { nom: string } | null;
  communes: { nom: string } | null;
}

/** Confiance globale (0-100). Lit _global (score composite pondéré) si présent, sinon moyenne simple. */
function avgConfidence(precision: Record<string, number> | null): number | null {
  if (!precision) return null;
  if (typeof precision._global === "number") return Math.round(precision._global * 100);
  const vals = Object.values(precision).filter((v) => typeof v === "number");
  if (!vals.length) return null;
  return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 100);
}

interface RawLine {
  invoice_id: string;
  poste_tarifaire: string | null;
  period_start: string | null;
  period_end: string | null;
  consommation_kwh: number | null;
  prix_unitaire_ckwh: number | null;
  montant_eur: number | null;
}

async function selectAll<T>(
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

/** Toutes les factures + leurs lignes de consommation (vraies données Supabase). */
export async function getInvoiceDocs(): Promise<InvoiceDoc[] | null> {
  const ctx = await getUserContext();
  if (!ctx) return null;

  const supabase = await createClient();

  const invoices = await selectAll<RawInvoice>((from, to) =>
    supabase
      .from("invoices")
      .select("id, facture_number, facture_date, total_ht, tva, autres_taxes, total_ttc, is_duplicata, categorie, file_path, archived, precision, sites(nom), communes(nom)")
      .eq("org_id", ctx.orgId)
      .order("facture_date", { ascending: false })
      .range(from, to),
  );

  if (!invoices || invoices.length === 0) return null;

  const invoiceIds = invoices.map((i) => i.id);

  const [lines, dbAnomalies] = await Promise.all([
    selectAll<RawLine>((from, to) =>
      supabase
        .from("consumption_periods")
        .select("invoice_id, poste_tarifaire, period_start, period_end, consommation_kwh, prix_unitaire_ckwh, montant_eur")
        .in("invoice_id", invoiceIds)
        .range(from, to),
    ),
    selectAll<{ invoice_id: string; type: string; severity: string; description: string }>((from, to) =>
      supabase
        .from("anomalies")
        .select("invoice_id, type, severity, description")
        .in("invoice_id", invoiceIds)
        .range(from, to),
    ),
  ]);

  // Index DB anomalies by invoice_id
  type RawAnomaly = { invoice_id: string; type: string; severity: string; description: string };
  const dbAnomaliesByInvoice = new Map<string, AnomalyLite[]>();
  for (const a of (dbAnomalies ?? []) as RawAnomaly[]) {
    const sev: Severity = a.severity === "high" ? "high" : a.severity === "medium" ? "medium" : "low";
    const arr = dbAnomaliesByInvoice.get(a.invoice_id) ?? [];
    arr.push({ type: a.type, severity: sev, message: a.description });
    dbAnomaliesByInvoice.set(a.invoice_id, arr);
  }

  const linesByInvoice = new Map<string, InvoiceLine[]>();
  for (const l of (lines ?? []) as RawLine[]) {
    const arr = linesByInvoice.get(l.invoice_id) ?? [];
    arr.push({
      poste: l.poste_tarifaire ?? "—",
      periode: periodeLabel(l.period_start, l.period_end),
      kwh: Number(l.consommation_kwh ?? 0),
      prix: l.prix_unitaire_ckwh != null ? Number(l.prix_unitaire_ckwh) : null,
      montant: Number(l.montant_eur ?? 0),
    });
    linesByInvoice.set(l.invoice_id, arr);
  }

  const docs: InvoiceDoc[] = invoices.map((i) => {
    const docLines = linesByInvoice.get(i.id) ?? [];
    return {
      id: i.id,
      number: i.facture_number ?? "—",
      date: i.facture_date,
      site: i.sites?.nom ?? "—",
      commune: i.communes?.nom ?? "—",
      categorie: i.categorie,
      isDuplicata: !!i.is_duplicata,
      totalHt: Number(i.total_ht ?? 0),
      tva: Number(i.tva ?? 0),
      autresTaxes: Number(i.autres_taxes ?? 0),
      totalTtc: Number(i.total_ttc ?? 0),
      kwh: docLines.reduce((s, l) => s + l.kwh, 0),
      lines: docLines,
      filePath: i.file_path ?? null,
      archived: !!i.archived,
      confidence: avgConfidence(i.precision),
    };
  });

  // Passe anomalies : la médiane du coût/kWh nécessite l'ensemble du portefeuille.
  // Médiane du coût/kWh PAR ANNÉE : les tarifs ont plus que doublé entre 2019 et 2024,
  // une médiane globale marquerait toutes les factures anciennes comme « coût bas ».
  const byYear = new Map<string, number[]>();
  for (const d of docs) {
    const c = costPerKwh(d.totalTtc, d.kwh);
    if (c == null) continue;
    const y = d.date.slice(0, 4);
    (byYear.get(y) ?? byYear.set(y, []).get(y)!).push(c);
  }
  const medianByYear = new Map<string, number | null>();
  for (const [y, vals] of byYear) medianByYear.set(y, median(vals));
  for (const d of docs) {
    const computed = detectAnomalies(
      { totalHt: d.totalHt, tva: d.tva, autresTaxes: d.autresTaxes ?? 0, totalTtc: d.totalTtc, kwh: d.kwh, isDuplicata: d.isDuplicata },
      { medianCostPerKwh: medianByYear.get(d.date.slice(0, 4)) ?? null },
    );
    const persisted = dbAnomaliesByInvoice.get(d.id) ?? [];
    // Merge: DB anomalies first (IDP + override), then computed business rules
    // Dedupe by type: DB wins over computed for the same type
    const seenTypes = new Set(persisted.map((a) => a.type));
    const newComputed = computed.filter((a) => !seenTypes.has(a.type));
    d.anomalies = [...persisted, ...newComputed];
    d.anomalySeverity = topSeverity(d.anomalies);
  }

  return docs;
}

const L = (poste: string, periode: string, kwh: number, prix: number | null, montant: number): InvoiceLine => ({ poste, periode, kwh, prix, montant });

/** Instantané des VRAIES factures (capturé via SQL) — repli pour le preview public. */
export const DEMO_INVOICE_DOCS: InvoiceDoc[] = [
  { id: "c4c3c28f", number: "SIM-237332-20240820", date: "2024-08-20", site: "Place Jules Pain", commune: "Fonds-Saint-Denis", categorie: "eclairage_public", isDuplicata: false, totalHt: 204.81, tva: 17.41, totalTtc: 229.99, kwh: 0, lines: [] },
  { id: "a6961cdd", number: "SIM-301246-20240814", date: "2024-08-14", site: "École du bourg", commune: "Grand'Rivière", categorie: "batiment", isDuplicata: false, totalHt: 214.55, tva: 18.24, totalTtc: 248.59, kwh: 0, lines: [] },
  { id: "17a53e96", number: "SIM-6003-20240812", date: "2024-08-12", site: "Écoles", commune: "Fonds-Saint-Denis", categorie: "batiment", isDuplicata: false, totalHt: 422.45, tva: 35.91, totalTtc: 489.13, kwh: 0, lines: [] },
  { id: "cf3ea663", number: "SIM-6038-20240805", date: "2024-08-05", site: "Fonds Mascret", commune: "Fonds-Saint-Denis", categorie: "eclairage_public", isDuplicata: false, totalHt: 221.36, tva: 18.82, totalTtc: 257.6, kwh: 0, lines: [] },
  { id: "a6793b95", number: "SIM-237329-20240218", date: "2024-02-18", site: "Podium", commune: "Fonds-Saint-Denis", categorie: "batiment", isDuplicata: false, totalHt: 456.47, tva: 38.8, totalTtc: 527.44, kwh: 0, lines: [] },
  { id: "2d83617a", number: "SIM-5977-20240215", date: "2024-02-15", site: "La Croix", commune: "Fonds-Saint-Denis", categorie: "eclairage_public", isDuplicata: false, totalHt: 428.98, tva: 36.46, totalTtc: 495.85, kwh: 0, lines: [] },
  { id: "22e71b9d", number: "SIM-301245-20240214", date: "2024-02-14", site: "Mairie", commune: "Grand'Rivière", categorie: "batiment", isDuplicata: false, totalHt: 255.52, tva: 21.72, totalTtc: 294.41, kwh: 0, lines: [] },
  { id: "0fce74ba", number: "SIM-256273-20240212", date: "2024-02-12", site: "Hôtel de Ville", commune: "Fonds-Saint-Denis", categorie: "batiment", isDuplicata: false, totalHt: 366.88, tva: 31.18, totalTtc: 422.6, kwh: 0, lines: [] },
  { id: "06d83d7f", number: "SIM-6061-20240210", date: "2024-02-10", site: "Bel Oncle", commune: "Fonds-Saint-Denis", categorie: "eclairage_public", isDuplicata: false, totalHt: 149.3, tva: 12.69, totalTtc: 171.89, kwh: 0, lines: [] },
  { id: "d25ff629", number: "SIM-301250-20230810", date: "2023-08-10", site: "Bourg", commune: "Grand'Rivière", categorie: "eclairage_public", isDuplicata: false, totalHt: 132.51, tva: 11.26, totalTtc: 153.68, kwh: 0, lines: [] },
  { id: "53a9c681", number: "13182184E", date: "2023-08-04", site: "Route de l'Observatoire", commune: "Fonds-Saint-Denis", categorie: "eclairage_public", isDuplicata: true, totalHt: 789.21, tva: 24.91, totalTtc: 911.59, kwh: 1694, lines: [
    L("base", "02/23 → 07/23", 833, 13.4914, 112.38),
    L("base", "02/23 → 08/23", 847, null, 0),
    L("base", "08/23 → 08/23", 14, 15.2544, 2.14),
  ] },
  { id: "6de311ec", number: "SIM-301251-20230210", date: "2023-02-10", site: "Anse Céron", commune: "Grand'Rivière", categorie: "eclairage_public", isDuplicata: false, totalHt: 151.06, tva: 12.84, totalTtc: 174.12, kwh: 0, lines: [] },
  { id: "b61517a0", number: "12634845E", date: "2023-02-06", site: "Bel Oncle", commune: "Fonds-Saint-Denis", categorie: "eclairage_public", isDuplicata: true, totalHt: 636.93, tva: 28.6, totalTtc: 746.52, kwh: 3340, lines: [
    L("base", "08/22 → 01/23", 1643, 11.8552, 194.78),
    L("base", "08/22 → 02/23", 1670, null, 0),
    L("base", "02/23 → 02/23", 27, 13.4914, 3.64),
  ] },
  { id: "e34cf886", number: "SIM-301250-20220810", date: "2022-08-10", site: "Bourg", commune: "Grand'Rivière", categorie: "eclairage_public", isDuplicata: false, totalHt: 284.19, tva: 24.16, totalTtc: 331.02, kwh: 0, lines: [] },
  { id: "1e746d9a", number: "10641872E", date: "2021-02-24", site: "Place Jules Pain", commune: "Fonds-Saint-Denis", categorie: "eclairage_public", isDuplicata: true, totalHt: 168.99, tva: 9.14, totalTtc: 224.44, kwh: 516, lines: [
    L("heures creuses", "08/20 → 01/21", 150, 8.2371, 12.36),
    L("heures pleines", "08/20 → 01/21", 303, 11.7171, 35.5),
    L("heures creuses", "02/21 → 02/21", 21, 8.8542, 1.86),
    L("heures pleines", "02/21 → 02/21", 42, 12.6442, 5.31),
  ] },
  { id: "530a7f0c", number: "8645375E", date: "2019-02-05", site: "Morne des Cadets", commune: "Fonds-Saint-Denis", categorie: "eclairage_public", isDuplicata: true, totalHt: 472.54, tva: 34.29, totalTtc: 680.5, kwh: 3299, lines: [
    L("heures pleines", "08/18 → 02/19", 1191, 6.4342, 76.63),
    L("heures creuses", "08/18 → 02/19", 2108, 6.4342, 135.63),
  ] },
  { id: "08079f28", number: "8186002E", date: "2018-08-14", site: "Fonds Mascret", commune: "Fonds-Saint-Denis", categorie: "eclairage_public", isDuplicata: true, totalHt: 957.84, tva: 99.21, totalTtc: 1501.73, kwh: 10944, lines: [
    L("heures pleines", "02/18 → 07/18", 3871, 6.5249, 252.58),
    L("heures creuses", "02/18 → 07/18", 6340, 6.5249, 413.68),
    L("heures creuses", "08/18 → 08/18", 455, 6.4342, 29.28),
    L("heures pleines", "08/18 → 08/18", 278, 6.4342, 17.89),
  ] },
  { id: "eaaab74a", number: "7267537E", date: "2017-08-31", site: "La Croix", commune: "Fonds-Saint-Denis", categorie: "eclairage_public", isDuplicata: true, totalHt: 1199.87, tva: 104.19, totalTtc: 1784.85, kwh: 10563, lines: [
    L("heures pleines", "02/17 → 07/17", 3283, 6.8106, 223.59),
    L("heures creuses", "02/17 → 07/17", 7050, 6.8106, 480.15),
    L("heures creuses", "08/17 → 08/17", 157, 6.4449, 10.12),
    L("heures pleines", "08/17 → 08/17", 73, 6.4449, 4.7),
  ] },
];
