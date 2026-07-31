// Utilitaires partagés pour l'affichage des anomalies. La détection elle-même
// vit désormais côté serveur (lib/anomalies/recompute.ts + persist.ts) et est
// persistée en base — plus de recalcul client ni de "resolved" en localStorage.

export type Severity = "low" | "medium" | "high";

export interface AnomalyLite {
  id: string;
  type: string;
  severity: Severity;
  message: string;
  resolved: boolean;
  /** Valeur en € de l'anomalie quand elle est quantifiable (écart de totaux, surcoût vs médiane) — sert au KPI "valeur détectée". */
  valueEur?: number;
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

/** Coût unitaire (c€/kWh) — passer un montant € et des kWh cohérents (idéalement énergie seule, hors abonnement/taxes). */
export function costPerKwh(montantEur: number, kwh: number): number | null {
  return kwh > 0 ? (montantEur / kwh) * 100 : null;
}

export const SEVERITY_LABEL: Record<Severity, string> = { low: "Faible", medium: "Moyenne", high: "Élevée" };
export const SEVERITY_COLOR: Record<Severity, string> = { low: "#94a3b8", medium: "#f59e0b", high: "#ef4444" };
