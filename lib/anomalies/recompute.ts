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
  type: "cout_kwh" | "consumption_spike";
  severity: Severity;
  description: string;
  detectedValue: number | null;
  expectedRangeMin: number | null;
  expectedRangeMax: number | null;
}

// ── Paramètres de détection du pic de consommation ──────────────────────────
// Calibrés sur le portefeuille réel (261 factures exploitables, 17 sites).
// L'ancien seuil relatif fixe (±40 % vs médiane) marquait 160 factures, soit 69 %
// de celles qu'il examinait : à ce taux la règle ne discrimine plus rien. Elle est
// remplacée par un écart robuste (MAD), qui juge une facture au regard de la
// dispersion habituelle de SON site — un site erratique doit dévier beaucoup pour
// alerter, un site régulier alerte sur moins. Durcir le seuil relatif ne suffisait
// pas : il fallait monter à ±150 % pour descendre à 47 alertes, ce qui rendait la
// règle aveugle sur les sites réguliers.
// Réglage retenu : 25 alertes (23 hausses, 2 baisses) réparties sur 7 sites.
/** Nombre d'écarts robustes au-delà duquel on alerte. */
const SPIKE_K = 3.5;
/** Écart au-delà duquel l'alerte passe en gravité haute. */
const SPIKE_K_HIGH = 5;
/** Factures de référence minimum sur le site — en dessous, la médiane n'a pas de sens. */
const SPIKE_MIN_HISTORY = 4;
/** Rapport de durée maximum toléré entre la facture jugée et une facture de référence. */
const SPIKE_MAX_DURATION_RATIO = 1.5;
/** En dessous, l'écart relatif s'emballe pour des variations sans enjeu. */
const SPIKE_MIN_KWH = 100;
/**
 * Plancher de dispersion, en fraction de la médiane. Sans lui, un site dont toutes les
 * factures de référence sont identiques donne un MAD nul, donc un écart infini : la
 * moindre variation deviendrait une alerte de gravité maximale.
 */
const SPIKE_SIGMA_FLOOR = 0.05;

/** Écart absolu médian — dispersion robuste, insensible aux valeurs extrêmes (contrairement à l'écart-type). */
function medianAbsoluteDeviation(values: number[], center: number): number | null {
  return median(values.map((v) => Math.abs(v - center)));
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
    }
    // Un coût unitaire BAS n'est pas signalé : ce n'est pas une anomalie de facture.
    // La règle `cout_kwh_bas` a été retirée — elle produisait 23 alertes qui disaient
    // en réalité « mon extraction est incomplète », pas « ta facture est anormale ».
  }

  // ── 2. Consommation anormale par site — écart robuste (MAD) vs la MÊME SAISON.
  //
  // La comparaison reste saisonnière (une variation été/hiver normale ne doit pas
  // alerter) et porte sur des kWh/jour (une période de 2 mois et une de 6 mois ne
  // sont pas comparables en volume brut). Ce qui change, c'est le juge : au lieu
  // d'un seuil relatif fixe identique pour tous les sites, on mesure l'écart en
  // nombre de dispersions habituelles DU SITE. ──
  const bySite = new Map<string, InvoiceMetrics[]>();
  for (const m of metrics) {
    if (!m.input.siteId || m.kwhPerDay == null || !m.periodEnd) continue;
    const arr = bySite.get(m.input.siteId) ?? [];
    arr.push(m);
    bySite.set(m.input.siteId, arr);
  }

  for (const [, siteInvoices] of bySite) {
    for (const target of siteInvoices) {
      if (target.kwhPerDay == null || target.kwhPerDay <= 0) continue;
      // Sous ce volume, un écart en pourcentage n'a pas de portée métier.
      if (target.totalKwh < SPIKE_MIN_KWH) continue;

      const others = siteInvoices.filter((m) => m.input.id !== target.input.id);
      if (others.length < SPIKE_MIN_HISTORY) continue;

      const targetQuarter = quarterOf(target.periodEnd!);
      const sameSeason = others.filter((m) => quarterOf(m.periodEnd!) === targetQuarter);
      const seasonal = sameSeason.length >= SPIKE_MIN_HISTORY;
      // Repli sur l'historique complet quand la même saison est trop peu fournie.
      const pool = seasonal ? sameSeason : others;

      // Une facture de 6 mois et une de 2 mois ne décrivent pas le même régime de
      // consommation, même ramenées au jour : lissage, saisonnalité interne et
      // régularisations diffèrent. On ne compare qu'à durée comparable.
      const targetDays = target.days ?? 0;
      const comparable = targetDays > 0
        ? pool.filter((m) => {
            const ratio = (m.days ?? 0) / targetDays;
            return ratio >= 1 / SPIKE_MAX_DURATION_RATIO && ratio <= SPIKE_MAX_DURATION_RATIO;
          })
        : pool;

      const rates = comparable.map((m) => m.kwhPerDay!).filter((r) => r > 0);
      if (rates.length < SPIKE_MIN_HISTORY) continue;

      const baseline = median(rates);
      if (!baseline || baseline <= 0) continue;

      const mad = medianAbsoluteDeviation(rates, baseline) ?? 0;
      // 1,4826 : facteur qui rend le MAD comparable à un écart-type sur une loi normale.
      const sigma = Math.max(1.4826 * mad, SPIKE_SIGMA_FLOOR * baseline);
      const z = (target.kwhPerDay - baseline) / sigma;
      if (Math.abs(z) <= SPIKE_K) continue;

      const deviation = (target.kwhPerDay - baseline) / baseline;
      const seasonNote = seasonal ? "vs même saison les années précédentes" : "vs historique du site";
      out.push({
        invoiceId: target.input.id,
        type: "consumption_spike",
        severity: Math.abs(z) > SPIKE_K_HIGH ? "high" : "medium",
        detectedValue: target.totalKwh,
        expectedRangeMin: Math.max(0, baseline - SPIKE_K * sigma) * targetDays,
        expectedRangeMax: (baseline + SPIKE_K * sigma) * targetDays,
        description: `Consommation ${deviation > 0 ? "en hausse" : "en baisse"} de ${Math.round(Math.abs(deviation) * 100)}% ${seasonNote} (${target.kwhPerDay.toFixed(1)} kWh/j vs réf. ${baseline.toFixed(1)} kWh/j) — écart de ${Math.abs(z).toFixed(1)}× la variation habituelle du site.`,
      });
    }
  }

  // La règle `conso_manquante` (facture réelle sans kWh extrait) a été retirée :
  // elle ne décrivait pas une anomalie de facture mais une extraction incomplète,
  // et saturait la page avec 25 alertes qu'aucun utilisateur ne pouvait traiter ici.

  return out;
}
