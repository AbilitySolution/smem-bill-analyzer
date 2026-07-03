// Détection d'anomalies par règles (fallback de démonstration — module Anomalies en version bêta).
// Indépendant du score de précision OCR ; basé sur la cohérence métier des factures.

export type Severity = "low" | "medium" | "high";

export interface AnomalyLite {
  type: string;
  severity: Severity;
  message: string;
}

const SEV_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

export function topSeverity(anoms: AnomalyLite[]): Severity | null {
  if (!anoms.length) return null;
  return anoms.reduce((a, b) => (SEV_RANK[b.severity] > SEV_RANK[a.severity] ? b : a)).severity;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const eur = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface AnomalyInput {
  totalHt: number;
  tva: number;
  autresTaxes: number;
  totalTtc: number;
  kwh: number;
  isDuplicata: boolean;
}

export interface AnomalyContext {
  medianCostPerKwh: number | null;
}

/** Coût unitaire « tout compris » d'une facture (c€/kWh). */
export function costPerKwh(totalTtc: number, kwh: number): number | null {
  return kwh > 0 ? (totalTtc / kwh) * 100 : null;
}

export function detectAnomalies(i: AnomalyInput, ctx: AnomalyContext): AnomalyLite[] {
  const out: AnomalyLite[] = [];

  // 1. Cohérence des totaux : HT + TVA + autres taxes ≈ TTC
  const expected = i.totalHt + i.tva + i.autresTaxes;
  const tol = Math.max(1.5, i.totalTtc * 0.015);
  if (i.totalTtc > 0 && Math.abs(expected - i.totalTtc) > tol) {
    out.push({
      type: "totaux",
      severity: "high",
      message: `Totaux incohérents : HT + TVA + taxes = ${eur(expected)} € ≠ TTC ${eur(i.totalTtc)} €.`,
    });
  }

  // 2. Coût unitaire atypique vs médiane du portefeuille
  const cpk = costPerKwh(i.totalTtc, i.kwh);
  if (cpk != null && ctx.medianCostPerKwh) {
    const ratio = cpk / ctx.medianCostPerKwh;
    const med = ctx.medianCostPerKwh.toFixed(1);
    if (ratio >= 2.2) {
      out.push({ type: "cout_kwh", severity: "high", message: `Coût unitaire très élevé : ${cpk.toFixed(1)} c€/kWh (médiane ${med}).` });
    } else if (ratio >= 1.5) {
      out.push({ type: "cout_kwh", severity: "medium", message: `Coût unitaire élevé : ${cpk.toFixed(1)} c€/kWh (médiane ${med}).` });
    } else if (ratio <= 0.65) {
      out.push({ type: "cout_kwh_bas", severity: "low", message: `Coût unitaire bas : ${cpk.toFixed(1)} c€/kWh (médiane ${med}).` });
    }
  }

  // 3. Consommation manquante sur une facture réelle
  if (i.isDuplicata && i.kwh === 0) {
    out.push({ type: "conso_manquante", severity: "low", message: "Aucune consommation (kWh) extraite sur une facture réelle." });
  }

  return out;
}

export const SEVERITY_LABEL: Record<Severity, string> = { low: "Faible", medium: "Moyenne", high: "Élevée" };
export const SEVERITY_COLOR: Record<Severity, string> = { low: "#94a3b8", medium: "#f59e0b", high: "#ef4444" };

// ── Résolutions persistées côté client (démo, sans écriture en base) ───────────
const LS_KEY = "ability:resolved-anomalies";
export const anomalyKey = (invoiceId: string, type: string) => `${invoiceId}:${type}`;

export function loadResolved(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    return new Set(JSON.parse(localStorage.getItem(LS_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

export function saveResolved(set: Set<string>) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...set]));
  } catch {
    /* stockage indisponible */
  }
}
