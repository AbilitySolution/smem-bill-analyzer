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

// ── Taxonomie des anomalies ─────────────────────────────────────────────────
// Le regroupement ne suit pas la nature technique du défaut mais L'ACTION QU'IL
// DÉCLENCHE et la personne qui la mène. C'est ce qui distingue des sections utiles
// de simples étiquettes : un agent technique, un acheteur et un gestionnaire de
// facturation ne cherchent pas les mêmes lignes.

export type AnomalySection = "consommation" | "tarif" | "facturation" | "autres";

export const SECTION_ORDER: AnomalySection[] = ["consommation", "tarif", "facturation", "autres"];

export const SECTION_META: Record<AnomalySection, { label: string; hint: string }> = {
  consommation: {
    label: "Consommation anormale",
    hint: "Le site consomme nettement plus — ou moins — que son propre historique. À vérifier sur place.",
  },
  tarif: {
    label: "Tarif & contrat",
    hint: "Le prix payé ou le type de contrat s'écarte de la référence. À instruire auprès du fournisseur.",
  },
  facturation: {
    label: "Erreur de facturation",
    hint: "La facture est incohérente avec elle-même : totaux, index ou montants. Un avoir est peut-être dû.",
  },
  autres: {
    label: "Autres signalements",
    hint: "Signalements sans famille attribuée — notamment les validations forcées manuellement.",
  },
};

const SECTION_BY_TYPE: Record<string, AnomalySection> = {
  // Ce que le site consomme
  consumption_spike: "consommation",
  missing_period: "consommation",
  // Ce qu'on paie, et à quelles conditions
  cout_kwh: "tarif",
  tarif_type_mismatch: "tarif",
  tariff_change: "tarif",
  // Ce que la facture dit d'elle-même
  ttc_mismatch: "facturation",
  amount_mismatch: "facturation",
  line_amount_mismatch: "facturation",
  index_inversion: "facturation",
  date_inversion: "facturation",
  negative_amount: "facturation",
  negative_line_amount: "facturation",
};

/**
 * Section d'affichage d'un type d'anomalie.
 *
 * Repli sur « autres » plutôt que sur une des trois familles : un type inconnu — ajouté
 * en base, ou écrit par une version plus récente du code — doit rester VISIBLE. Le ranger
 * d'office quelque part le rendrait indiscernable et fausserait le compteur de cette
 * famille. La section n'apparaît que si elle contient quelque chose.
 */
export function sectionOf(type: string): AnomalySection {
  return SECTION_BY_TYPE[type] ?? "autres";
}

/** Libellé court par type, pour la puce affichée sur chaque alerte. */
export const TYPE_LABEL: Record<string, string> = {
  consumption_spike: "Écart de consommation",
  missing_period: "Période manquante",
  cout_kwh: "Surcoût au kWh",
  tarif_type_mismatch: "Type de tarif incohérent",
  tariff_change: "Changement de tarif",
  ttc_mismatch: "Total TTC incohérent",
  amount_mismatch: "Montant incohérent",
  line_amount_mismatch: "Ligne incohérente",
  index_inversion: "Index inversé",
  date_inversion: "Dates inversées",
  negative_amount: "Montant négatif",
  negative_line_amount: "Ligne négative",
  validation_override: "Validation forcée",
};

export function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type.replace(/_/g, " ");
}
