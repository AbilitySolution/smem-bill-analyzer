// Détection d'anomalies "portefeuille" — nécessite le contexte de TOUTES les
// factures de l'org (médiane cout/kWh, historique par site), donc calculée à
// part des contrôles structurels à l'extraction (lib/anthropic/invoice-validation.ts,
// qui reste la source pour totaux/index/dates/tarif_type — inchangés).
//
// Remplace l'ancien double système (detectAnomalies() recalculé côté client à
// chaque rendu + bloc consumption_spike inline dans app/api/invoices/route.ts) :
// une seule fonction pure, appelée côté serveur, dont le résultat est persisté
// en base (table anomalies) — permet un "resolved" partagé entre utilisateurs
// d'une même org au lieu d'un état localStorage par navigateur.
import { median, costPerKwh } from "@/lib/data/anomalies";

export type Categorie = "batiment" | "eclairage_public";
export type Severity = "low" | "medium" | "high";

export interface AnomalyLineInput {
  periodStart: string | null;
  periodEnd: string | null;
  kwh: number;
  montantEur: number;
}

export interface AnomalyInvoiceInput {
  id: string;
  siteId: string | null;
  categorie: Categorie | null;
  factureDate: string; // YYYY-MM-DD
  totalTtc: number;
  isDuplicata: boolean;
  lines: AnomalyLineInput[];
}

export interface ComputedAnomaly {
  invoiceId: string;
  type: "cout_kwh" | "cout_kwh_bas" | "consumption_spike" | "conso_manquante";
  severity: Severity;
  description: string;
  detectedValue: number | null;
  expectedRangeMin: number | null;
  expectedRangeMax: number | null;
}

interface InvoiceMetrics {
  input: AnomalyInvoiceInput;
  totalKwh: number;
  energyEur: number;
  cpk: number | null; // c€/kWh, énergie seule
  periodStart: string | null;
  periodEnd: string | null;
  days: number | null;
  kwhPerDay: number | null;
}

function computeMetrics(inv: AnomalyInvoiceInput): InvoiceMetrics {
  const totalKwh = inv.lines.reduce((s, l) => s + l.kwh, 0);
  const energyEur = inv.lines.reduce((s, l) => s + l.montantEur, 0);
  const cpk = costPerKwh(energyEur, totalKwh);

  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  for (const l of inv.lines) {
    if (l.periodStart && (!periodStart || l.periodStart < periodStart)) periodStart = l.periodStart;
    if (l.periodEnd && (!periodEnd || l.periodEnd > periodEnd)) periodEnd = l.periodEnd;
  }
  const days = periodStart && periodEnd
    ? (new Date(periodEnd).getTime() - new Date(periodStart).getTime()) / 86_400_000
    : null;
  const kwhPerDay = days && days > 0 ? totalKwh / days : null;

  return { input: inv, totalKwh, energyEur, cpk, periodStart, periodEnd, days, kwhPerDay };
}

/** Trimestre (0-3) du mois de fin de période — sert de proxy saison sans dépendance externe. */
function quarterOf(dateStr: string): number {
  return Math.floor(new Date(dateStr).getUTCMonth() / 3);
}

const eur = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

export function computePortfolioAnomalies(invoices: AnomalyInvoiceInput[]): ComputedAnomaly[] {
  const out: ComputedAnomaly[] = [];
  const metrics = invoices.map(computeMetrics);

  // ── 1. Coût kWh vs médiane, segmentée par (année, catégorie) — P2 : un site
  // éclairage public n'est plus comparé à une médiane qui mélange les bâtiments. ──
  const buckets = new Map<string, number[]>();
  for (const m of metrics) {
    if (m.cpk == null) continue;
    const key = `${m.input.factureDate.slice(0, 4)}|${m.input.categorie ?? "?"}`;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(m.cpk);
  }
  const bucketMedian = new Map<string, number | null>();
  for (const [key, values] of buckets) bucketMedian.set(key, median(values));

  for (const m of metrics) {
    if (m.cpk == null) continue;
    const key = `${m.input.factureDate.slice(0, 4)}|${m.input.categorie ?? "?"}`;
    const med = bucketMedian.get(key);
    if (!med) continue;
    const ratio = m.cpk / med;
    const surcoutEur = ((m.cpk - med) / 100) * m.totalKwh;
    if (ratio >= 2.2) {
      out.push({ invoiceId: m.input.id, type: "cout_kwh", severity: "high", detectedValue: surcoutEur, expectedRangeMin: null, expectedRangeMax: null,
        description: `Coût unitaire très élevé : ${m.cpk.toFixed(1)} c€/kWh (médiane ${med.toFixed(1)} pour cette catégorie/année) — soit environ ${eur(Math.abs(surcoutEur))} € au-dessus du tarif habituel.` });
    } else if (ratio >= 1.5) {
      out.push({ invoiceId: m.input.id, type: "cout_kwh", severity: "medium", detectedValue: surcoutEur, expectedRangeMin: null, expectedRangeMax: null,
        description: `Coût unitaire élevé : ${m.cpk.toFixed(1)} c€/kWh (médiane ${med.toFixed(1)} pour cette catégorie/année) — soit environ ${eur(Math.abs(surcoutEur))} € au-dessus du tarif habituel.` });
    } else if (ratio <= 0.65) {
      out.push({ invoiceId: m.input.id, type: "cout_kwh_bas", severity: "low", detectedValue: null, expectedRangeMin: null, expectedRangeMax: null,
        description: `Coût unitaire bas : ${m.cpk.toFixed(1)} c€/kWh (médiane ${med.toFixed(1)} pour cette catégorie/année).` });
    }
  }

  // ── 2. Pic de consommation par site, comparé à la MÊME SAISON historique — P1 :
  // recalculé sur tout le portefeuille (pas juste à l'ingestion), et ajusté saison
  // au lieu d'une moyenne brute (une variation été/hiver normale ne doit pas
  // déclencher une fausse alerte). ──
  const bySite = new Map<string, InvoiceMetrics[]>();
  for (const m of metrics) {
    if (!m.input.siteId || m.kwhPerDay == null || !m.periodEnd) continue;
    const arr = bySite.get(m.input.siteId) ?? [];
    arr.push(m);
    bySite.set(m.input.siteId, arr);
  }

  for (const [, siteInvoices] of bySite) {
    for (const target of siteInvoices) {
      const others = siteInvoices.filter((m) => m.input.id !== target.input.id);
      if (others.length < 2) continue;

      const targetQuarter = quarterOf(target.periodEnd!);
      const sameSeason = others.filter((m) => quarterOf(m.periodEnd!) === targetQuarter);
      const pool = sameSeason.length >= 2 ? sameSeason : others; // repli sur l'historique complet si pas assez de même saison
      const rates = pool.map((m) => m.kwhPerDay!).filter((r) => r > 0);
      const baseline = median(rates);
      if (!baseline || target.kwhPerDay == null || target.kwhPerDay <= 0) continue;

      const deviation = (target.kwhPerDay - baseline) / baseline;
      if (Math.abs(deviation) <= 0.4) continue;

      const days = target.days ?? 0;
      const seasonNote = sameSeason.length >= 2 ? "vs même saison les années précédentes" : "vs historique du site";
      out.push({
        invoiceId: target.input.id,
        type: "consumption_spike",
        severity: Math.abs(deviation) > 0.8 ? "high" : "medium",
        detectedValue: target.totalKwh,
        expectedRangeMin: baseline * 0.6 * days,
        expectedRangeMax: baseline * 1.4 * days,
        description: `Consommation ${deviation > 0 ? "en hausse" : "en baisse"} de ${Math.round(Math.abs(deviation) * 100)}% ${seasonNote} (${target.kwhPerDay.toFixed(1)} kWh/j vs réf. ${baseline.toFixed(1)} kWh/j).`,
      });
    }
  }

  // ── 3. Consommation manquante sur une facture réelle (non-duplicata). ──
  for (const m of metrics) {
    if (!m.input.isDuplicata && m.totalKwh === 0) {
      out.push({ invoiceId: m.input.id, type: "conso_manquante", severity: "low", detectedValue: null, expectedRangeMin: null, expectedRangeMax: null,
        description: "Aucune consommation (kWh) extraite sur une facture réelle." });
    }
  }

  return out;
}
