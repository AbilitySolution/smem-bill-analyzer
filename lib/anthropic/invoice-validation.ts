import type { InvoiceExtraction } from "./invoice-schema";

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  code: string;
  severity: ValidationSeverity;
  message: string;
  field?: string;
  expected?: number;
  actual?: number;
  delta?: number;
}

export interface ValidationResult {
  isValid: boolean;
  issues: ValidationIssue[];
  confidence: number;
  fieldConfidence: Record<string, number>;
  needsReview: boolean;
}

function approxEqual(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// Arithmetic signal: how well does the computed value match the declared one?
function arithScore(delta: number, tol1: number, tol2: number): number {
  if (delta < tol1) return 1.0;
  if (delta < tol2) return 0.65;
  return 0.1;
}

// Format signal for each field type
function fmtDate(d: string | null | undefined): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(d ?? "") ? 1.0 : 0.15;
}
function fmtPosNum(n: number): number {
  return n > 0 ? 0.95 : 0.4;
}
function fmtNonNeg(n: number): number {
  return n >= 0 ? 0.9 : 0.1;
}
function fmtStr(s: string | null | undefined, minLen = 3): number {
  return (s?.length ?? 0) >= minLen ? 0.9 : 0.2;
}

// composite(self, arith, fmt) = 0.2×self + 0.5×arith + 0.3×fmt
// compositeNoArith(self, fmt)  = 0.3×self + 0.7×fmt
function composite(self: number, arith: number, fmt: number): number {
  return clamp01(0.2 * self + 0.5 * arith + 0.3 * fmt);
}
function compositeNoArith(self: number, fmt: number): number {
  return clamp01(0.3 * self + 0.7 * fmt);
}

const FIELD_WEIGHTS: Record<string, number> = {
  facture_number: 3,
  facture_date: 2,
  total_ht: 3,
  tva: 2,
  autres_taxes: 1,
  total_ttc: 3,
  contract_number: 3,
  puissance_souscrite_kva: 1,
};

function computeFieldConfidences(data: InvoiceExtraction): Record<string, number> {
  const { invoice, fixed_charges, consumption_lines, precision, contract } = data;
  const p = precision ?? {};

  // --- Arithmetic signals ---
  const tva = invoice.tva ?? 0;
  const autresTaxes = invoice.autres_taxes ?? 0;
  const computedTTC = invoice.total_ht + tva + autresTaxes;
  const ttcDelta = Math.abs(computedTTC - invoice.total_ttc);
  const ttcArith = arithScore(ttcDelta, 0.05, 1.5);

  const hasLines = fixed_charges.length > 0 || consumption_lines.length > 0;
  const sumFixed = fixed_charges.reduce((s, c) => s + c.montant_eur, 0);
  const sumConso = consumption_lines.reduce((s, c) => s + c.montant_eur, 0);
  const htDelta = Math.abs(sumFixed + sumConso - invoice.total_ht);
  const htArith = hasLines ? arithScore(htDelta, 0.1, 2.0) : 0.5;

  // total_ht gets boost from both TTC check and lines check
  const htArithCombined = hasLines ? (ttcArith + htArith) / 2 : ttcArith;

  // EDF contract_number: typically 10–14 digits
  const contractFmt = /^\d{8,16}$/.test(contract.contract_number ?? "")
    ? 1.0
    : fmtStr(contract.contract_number, 4);

  return {
    facture_number: compositeNoArith(p.facture_number ?? 0.7, fmtStr(invoice.facture_number, 4)),
    facture_date: compositeNoArith(p.facture_date ?? 0.7, fmtDate(invoice.facture_date)),
    total_ht: composite(p.total_ht ?? 0.7, htArithCombined, fmtPosNum(invoice.total_ht)),
    tva: composite(p.tva ?? 0.7, ttcArith, fmtNonNeg(tva)),
    autres_taxes: composite(p.autres_taxes ?? 0.7, ttcArith, fmtNonNeg(autresTaxes)),
    total_ttc: composite(p.total_ttc ?? 0.7, ttcArith, fmtPosNum(invoice.total_ttc)),
    contract_number: compositeNoArith(p.contract_number ?? 0.7, contractFmt),
    puissance_souscrite_kva: compositeNoArith(
      p.puissance_souscrite_kva ?? 0.7,
      contract.puissance_souscrite_kva != null ? 0.9 : 0.35,
    ),
  };
}

function globalConfidence(fieldConfidence: Record<string, number>): number {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const [field, score] of Object.entries(fieldConfidence)) {
    const w = FIELD_WEIGHTS[field] ?? 1;
    weightedSum += score * w;
    totalWeight += w;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : 0.5;
}

export function validateInvoice(data: InvoiceExtraction): ValidationResult {
  const issues: ValidationIssue[] = [];
  const { invoice, fixed_charges, consumption_lines } = data;

  // --- Field-level composite confidence (replaces raw Claude self-score) ---
  const fieldConfidence = computeFieldConfidences(data);
  const confidence = globalConfidence(fieldConfidence);

  // 1. TTC = HT + TVA + autres_taxes
  const tva = invoice.tva ?? 0;
  const autresTaxes = invoice.autres_taxes ?? 0;
  const computedTTC = invoice.total_ht + tva + autresTaxes;
  const ttcDelta = Math.abs(computedTTC - invoice.total_ttc);
  if (!approxEqual(computedTTC, invoice.total_ttc, 0.05)) {
    issues.push({
      code: "TTC_MISMATCH",
      severity: ttcDelta > 1 ? "error" : "warning",
      message: `HT (${invoice.total_ht}) + TVA (${tva}) + autres taxes (${autresTaxes}) = ${computedTTC.toFixed(2)} ≠ TTC (${invoice.total_ttc}) — écart ${ttcDelta.toFixed(2)} €`,
      field: "invoice.total_ttc",
      expected: computedTTC,
      actual: invoice.total_ttc,
      delta: computedTTC - invoice.total_ttc,
    });
  }

  // 2. HT = sum(fixed) + sum(consumption)
  const hasLines = fixed_charges.length > 0 || consumption_lines.length > 0;
  if (hasLines) {
    const sumFixed = fixed_charges.reduce((s, c) => s + c.montant_eur, 0);
    const sumConsumption = consumption_lines.reduce((s, c) => s + c.montant_eur, 0);
    const computedHT = sumFixed + sumConsumption;
    const htDelta = Math.abs(computedHT - invoice.total_ht);
    if (!approxEqual(computedHT, invoice.total_ht, 0.10)) {
      const hint =
        computedHT > invoice.total_ht
          ? ` — une charge fixe (ex. CTA) est peut-être hors HT et devrait aller dans Taxes`
          : ` — une taxe (ex. CTA) est peut-être dans HT et devrait aller dans Charges fixes`;
      issues.push({
        code: "HT_LINES_MISMATCH",
        severity: htDelta > 2 ? "error" : "warning",
        message: `Lignes fixes (${sumFixed.toFixed(2)}) + conso (${sumConsumption.toFixed(2)}) = ${computedHT.toFixed(2)} ≠ HT (${invoice.total_ht}) — écart ${htDelta.toFixed(2)} €${hint}`,
        field: "invoice.total_ht",
        expected: computedHT,
        actual: invoice.total_ht,
        delta: computedHT - invoice.total_ht,
      });
    }
  }

  // 3. Per consumption line checks
  // Pre-build index groups: lines sharing (compteur|ancien|nouveau) are barème sub-splits —
  // their kWh must be checked as a group sum, not individually.
  const indexGroupMap = new Map<string, number[]>();
  for (let i = 0; i < consumption_lines.length; i++) {
    const l = consumption_lines[i];
    if (l.ancien_index != null && l.nouveau_index != null) {
      const key = `${l.numero_compteur ?? ""}|${l.ancien_index}|${l.nouveau_index}`;
      if (!indexGroupMap.has(key)) indexGroupMap.set(key, []);
      indexGroupMap.get(key)!.push(i);
    }
  }
  // Lines that belong to a multi-line group (barème split) — skip individual kWh check
  const inSharedGroup = new Set<number>();
  for (const indices of indexGroupMap.values()) {
    if (indices.length > 1) indices.forEach((i) => inSharedGroup.add(i));
  }

  for (let i = 0; i < consumption_lines.length; i++) {
    const line = consumption_lines[i];
    const tag = `[${line.poste_tarifaire} #${i + 1}]`;

    if (line.prix_unitaire_ckwh != null && line.consommation_kwh > 0) {
      const expectedMontant = (line.consommation_kwh * line.prix_unitaire_ckwh) / 100;
      const lineTol = Math.max(0.05, line.montant_eur * 0.015);
      if (!approxEqual(expectedMontant, line.montant_eur, lineTol)) {
        issues.push({
          code: "LINE_AMOUNT_MISMATCH",
          severity: "warning",
          message: `${tag} ${line.consommation_kwh} kWh × ${line.prix_unitaire_ckwh} c€/kWh = ${expectedMontant.toFixed(2)} € ≠ montant (${line.montant_eur} €)`,
          field: `consumption_lines[${i}].montant_eur`,
          expected: expectedMontant,
          actual: line.montant_eur,
          delta: expectedMontant - line.montant_eur,
        });
      }
    }

    if (line.ancien_index != null && line.nouveau_index != null) {
      if (line.ancien_index > line.nouveau_index) {
        issues.push({
          code: "INDEX_INVERSION",
          severity: "warning",
          message: `${tag} ancien index (${line.ancien_index}) > nouveau index (${line.nouveau_index}) — compteur réinitialisé ?`,
          field: `consumption_lines[${i}].ancien_index`,
        });
      } else if (!inSharedGroup.has(i) && line.coefficient != null && line.consommation_kwh > 0) {
        // Single-line group: check individual kWh
        const expectedKwh = (line.nouveau_index - line.ancien_index) * line.coefficient;
        const kwhTol = Math.max(1, line.consommation_kwh * 0.01);
        if (expectedKwh >= 0 && !approxEqual(expectedKwh, line.consommation_kwh, kwhTol)) {
          issues.push({
            code: "INDEX_KWH_MISMATCH",
            severity: "warning",
            message: `${tag} (${line.nouveau_index} - ${line.ancien_index}) × ${line.coefficient} = ${expectedKwh.toFixed(0)} kWh ≠ ${line.consommation_kwh} kWh`,
            field: `consumption_lines[${i}].consommation_kwh`,
            expected: expectedKwh,
            actual: line.consommation_kwh,
            delta: expectedKwh - line.consommation_kwh,
          });
        }
      }
    }

    if (line.date_debut && line.date_fin && line.date_debut > line.date_fin) {
      issues.push({
        code: "DATE_INVERSION",
        severity: "error",
        message: `${tag} date début (${line.date_debut}) > date fin (${line.date_fin})`,
        field: `consumption_lines[${i}].date_debut`,
      });
    }
  }

  // Group kWh check for barème-split lines (shared index groups)
  for (const [, indices] of indexGroupMap) {
    if (indices.length <= 1) continue;
    const first = consumption_lines[indices[0]];
    if (first.ancien_index == null || first.nouveau_index == null) continue;
    const coeff = first.coefficient ?? 1;
    const expectedKwh = (first.nouveau_index - first.ancien_index) * coeff;
    const sumKwh = indices.reduce((s, i) => s + consumption_lines[i].consommation_kwh, 0);
    const kwhTol = Math.max(1, expectedKwh * 0.01);
    if (expectedKwh >= 0 && !approxEqual(expectedKwh, sumKwh, kwhTol)) {
      const postes = indices.map((i) => consumption_lines[i].poste_tarifaire).join("+");
      issues.push({
        code: "INDEX_KWH_MISMATCH",
        severity: "warning",
        message: `[${postes}] somme sous-périodes (${sumKwh.toFixed(0)} kWh) ≠ (${first.nouveau_index} − ${first.ancien_index}) × ${coeff} = ${expectedKwh.toFixed(0)} kWh`,
        expected: expectedKwh,
        actual: sumKwh,
        delta: expectedKwh - sumKwh,
      });
    }
  }

  // 4. Low composite-confidence flags (use fieldConfidence, not raw precision)
  const criticalFields = ["total_ttc", "total_ht", "facture_number", "contract_number"] as const;
  for (const field of criticalFields) {
    const score = fieldConfidence[field];
    if (score != null && score < 0.6) {
      issues.push({
        code: "LOW_CONFIDENCE",
        severity: score < 0.4 ? "error" : "warning",
        message: `Faible confiance "${field}" (${Math.round(score * 100)}%) — vérifier manuellement`,
        field: `precision.${field}`,
      });
    }
  }

  const hasErrors = issues.some((i) => i.severity === "error");

  return {
    isValid: !hasErrors,
    issues,
    confidence,
    fieldConfidence,
    needsReview: issues.length > 0 || confidence < 0.75,
  };
}
