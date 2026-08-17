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

/* ------------------------------------------------------------------ *
 * Cohérence des périodes de facturation
 * ------------------------------------------------------------------ */

/** Durée moyenne d'un mois en jours — EDF facture au prorata, pas en mois calendaires. */
const JOURS_PAR_MOIS = 30.44;

/** Écart toléré entre durée annoncée et durée calculée, en mois. */
const TOLERANCE_DUREE_MOIS = 0.5;

/**
 * Durée que le libellé annonce lui-même, en mois.
 *
 * EDF écrit deux fois la même information : « prime fixe du 14 mars 2016 au 31 juillet 2016
 * (puissance souscrite de 6 kVA - 4,57 mois) ». Le document porte donc sa propre
 * vérification — c'est la seule prise disponible sur des dates, qu'aucun calcul de montant
 * ne peut confirmer.
 */
function dureeAnnonceeMois(libelle: string | null | undefined): number | null {
  const found = /([0-9]+(?:[.,][0-9]+)?)\s*mois/i.exec(libelle ?? "");
  if (!found) return null;
  const value = Number.parseFloat(found[1].replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

/** Durée réelle entre deux dates ISO, en mois. `null` si l'une des deux manque ou est invalide. */
function dureeReelleMois(debut: string | null | undefined, fin: string | null | undefined): number | null {
  if (!debut || !fin) return null;
  const d = Date.parse(debut);
  const f = Date.parse(fin);
  if (Number.isNaN(d) || Number.isNaN(f)) return null;
  return (f - d) / (86_400_000 * JOURS_PAR_MOIS);
}

/**
 * Écart maximal constaté entre durée annoncée et durée calculée, sur toutes les lignes qui
 * annoncent une durée. `null` si aucune ligne n'en annonce — la facture ne fournit alors
 * aucune prise, et l'absence de signal ne doit pas être lue comme un signal négatif.
 *
 * Sert à la fois d'alerte (ci-dessous) et de signal arithmétique pour la confiance : c'est
 * l'équivalent, pour les dates, de ce que `ttcArith` est pour les montants.
 */
function ecartDureeMax(data: InvoiceExtraction): number | null {
  let pire: number | null = null;
  for (const ligne of [...(data.fixed_charges ?? []), ...(data.taxes ?? [])]) {
    const annoncee = dureeAnnonceeMois(ligne.libelle);
    const reelle = dureeReelleMois(ligne.date_debut, ligne.date_fin);
    if (annoncee == null || reelle == null) continue;
    const ecart = Math.abs(annoncee - reelle);
    if (pire == null || ecart > pire) pire = ecart;
  }
  return pire;
}

// composite(self, arith, fmt) = 0.2×self + 0.5×arith + 0.3×fmt
// compositeNoArith(self, fmt)  = 0.3×self + 0.7×fmt
function composite(self: number, arith: number, fmt: number): number {
  return clamp01(0.2 * self + 0.5 * arith + 0.3 * fmt);
}
function compositeNoArith(self: number, fmt: number): number {
  return clamp01(0.3 * self + 0.7 * fmt);
}
/**
 * Champs que le modèle ne note pas lui-même (il n'émet pas de `precision.periodes`).
 *
 * Réutiliser `composite` ici plafonnerait le champ à 0,8 même parfaitement lu, puisque la
 * part `self` vaudrait zéro faute de score — la note baisserait sur toutes les factures, y
 * compris les justes. Le poids du `self` est donc redistribué sur les deux signaux réels.
 */
function compositeNoSelf(arith: number, fmt: number): number {
  return clamp01(0.65 * arith + 0.35 * fmt);
}

/**
 * Normalise les libellés de postes tarifaires EDF vers des codes canoniques.
 * Ex : "Heure P", "Heures Pleines", "H.P." → "HP"
 *      "Heure Creuse", "H.C." → "HC"
 *      "HP Bleu" → "HPB"  (TEMPO)
 * Retourne la valeur d'origine si aucun pattern ne correspond.
 */
export function normalizePosteTarifaire(raw: string | null | undefined): string {
  if (!raw) return raw ?? "";
  // Minuscules + sans accents + ponctuation → espace pour simplifier le matching
  const s = raw.trim()
    .toLowerCase()
    .normalize("NFD").replace(/\p{Mn}/gu, "")
    .replace(/[.\-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // TEMPO couleurs — doit passer AVANT hp/hc génériques
  // Gère aussi les anciens codes "tempo hp/hc" retournés avant standardisation du prompt
  if (/^hpb$|hp.*(bleu|blue)|^tempo.?hp.*b/.test(s)) return "HPB";
  if (/^hcb$|hc.*(bleu|blue)|^tempo.?hc.*b/.test(s)) return "HCB";
  if (/^(hpw|hpbn|hpbl)$|hp.*(blanc|white)|^tempo.?hp.*bl/.test(s)) return "HPW";
  if (/^(hcw|hcbn|hcbl)$|hc.*(blanc|white)|^tempo.?hc.*bl/.test(s)) return "HCW";
  if (/^hpr$|hp.*(rouge|red)|^tempo.?hp.*r/.test(s)) return "HPR";
  if (/^hcr$|hc.*(rouge|red)|^tempo.?hc.*r/.test(s)) return "HCR";
  // "TEMPO_HP" sans couleur → garder HP générique (fallback)
  if (/^tempo.?hp$/.test(s)) return "HP";
  if (/^tempo.?hc$/.test(s)) return "HC";

  // EJP
  if (/^ejpn$|ejp.*norm/.test(s)) return "EJPN";
  if (/^ejpp$|ejp.*point/.test(s)) return "EJPP";
  if (/^ejp$/.test(s)) return "EJP";

  // HP / HC génériques (après TEMPO pour éviter HPB → HP)
  if (/^h ?\.?p\.?$|heure?s? p(lein)?/.test(s)) return "HP";
  if (/^h ?\.?c\.?$|heure?s? c(reus)?/.test(s)) return "HC";

  // BASE
  if (/^base?$/.test(s)) return "BASE";

  return raw.trim();
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
  periodes: 2,
};

function computeFieldConfidences(data: InvoiceExtraction): Record<string, number> {
  const { invoice, precision, contract } = data;
  const p = precision ?? {};

  // --- Arithmetic signals ---
  const tva = invoice.tva ?? 0;
  const autresTaxes = invoice.autres_taxes ?? 0;
  const computedTTC = invoice.total_ht + tva + autresTaxes;
  const ttcDelta = Math.abs(computedTTC - invoice.total_ttc);
  const ttcArith = arithScore(ttcDelta, 0.05, 1.5);

  // EDF contract_number: typically 10–14 digits
  const contractFmt = /^\d{8,16}$/.test(contract.contract_number ?? "")
    ? 1.0
    : fmtStr(contract.contract_number, 4);

  // Signal arithmétique sur les dates : écart entre la durée que le libellé annonce et
  // celle que couvrent les dates extraites. Absent quand aucune ligne n'annonce de durée —
  // la clé n'est alors pas émise du tout, plutôt que notée arbitrairement : une facture
  // sans prise de vérification ne doit être ni récompensée ni pénalisée.
  const ecartDuree = ecartDureeMax(data);

  return {
    ...(ecartDuree != null
      ? { periodes: compositeNoSelf(arithScore(ecartDuree, TOLERANCE_DUREE_MOIS, 1.5), 1) }
      : {}),
    facture_number: compositeNoArith(p.facture_number ?? 0, fmtStr(invoice.facture_number, 4)),
    facture_date: compositeNoArith(p.facture_date ?? 0, fmtDate(invoice.facture_date)),
    total_ht: composite(p.total_ht ?? 0, ttcArith, fmtPosNum(invoice.total_ht)),
    tva: composite(p.tva ?? 0, ttcArith, fmtNonNeg(tva)),
    autres_taxes: composite(p.autres_taxes ?? 0, ttcArith, fmtNonNeg(autresTaxes)),
    total_ttc: composite(p.total_ttc ?? 0, ttcArith, fmtPosNum(invoice.total_ttc)),
    contract_number: compositeNoArith(p.contract_number ?? 0, contractFmt),
    puissance_souscrite_kva: compositeNoArith(
      p.puissance_souscrite_kva ?? 0,
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
  const { invoice, consumption_lines, contract } = data;

  // --- Field-level composite confidence (replaces raw Claude self-score) ---
  const fieldConfidence = computeFieldConfidences(data);
  const confidence = globalConfidence(fieldConfidence);

  // 0. Montants négatifs — facture avoir légitime ou erreur OCR indiscernable → error
  if (invoice.total_ht < 0 || invoice.total_ttc < 0) {
    issues.push({
      code: "NEGATIVE_AMOUNT",
      severity: "error",
      message: `Montant négatif : HT = ${invoice.total_ht} €, TTC = ${invoice.total_ttc} € — facture avoir ou erreur d'extraction ?`,
      field: invoice.total_ht < 0 ? "invoice.total_ht" : "invoice.total_ttc",
    });
  }

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

  // 2. Per consumption line checks
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
        // Un index qui recule n'est pas anormal en soi : sur une ligne d'avoir, la
        // consommation et le montant sont négatifs et le recul est cohérent — 6 lignes du
        // corpus sont dans ce cas et n'ont rien à signaler.
        //
        // La contradiction, c'est un index qui recule ALORS QUE la consommation est
        // positive : 55 392 → 34 553 ne peut pas produire +6 589 kWh. Les deux nombres se
        // démentent, donc l'un des deux est mal lu. 3 lignes du corpus, toutes fausses.
        const contradiction = line.consommation_kwh > 0;
        issues.push({
          code: contradiction ? "INDEX_CONSUMPTION_CONTRADICTION" : "INDEX_INVERSION",
          severity: contradiction ? "error" : "warning",
          message: contradiction
            ? `${tag} l'index recule (${line.ancien_index} → ${line.nouveau_index}) alors que la consommation est positive (${line.consommation_kwh} kWh) — les deux valeurs se contredisent`
            : `${tag} ancien index (${line.ancien_index}) > nouveau index (${line.nouveau_index}) — compteur réinitialisé ?`,
          field: `consumption_lines[${i}].ancien_index`,
        });
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

    if (line.montant_eur < 0) {
      issues.push({
        code: "NEGATIVE_LINE_AMOUNT",
        severity: "warning",
        message: `${tag} montant négatif (${line.montant_eur} €)`,
        field: `consumption_lines[${i}].montant_eur`,
        actual: line.montant_eur,
      });
    }
  }

  // 2c. Cohérence des périodes sur les charges et taxes.
  //
  // Les dates n'ont aucune contrainte de calcul : rien ne permet de confirmer qu'une date
  // lue est la bonne — c'est le trou par lequel « 14 mars 2016 » est devenu « 14 mars 2010 »
  // sans que la confiance globale ne bouge. Sauf qu'EDF écrit la durée dans le libellé :
  // le document se vérifie lui-même.
  for (const [index, ligne] of [...(data.fixed_charges ?? []), ...(data.taxes ?? [])].entries()) {
    const etiquette = `[${ligne.libelle || `ligne ${index + 1}`}]`;

    if (ligne.date_debut && ligne.date_fin && ligne.date_debut > ligne.date_fin) {
      issues.push({
        code: "PERIOD_REVERSED",
        severity: "error",
        message: `${etiquette} période inversée : début (${ligne.date_debut}) après fin (${ligne.date_fin})`,
        field: `charges[${index}].date_debut`,
      });
      continue; // durée non calculable sur une période inversée
    }

    const annoncee = dureeAnnonceeMois(ligne.libelle);
    const reelle = dureeReelleMois(ligne.date_debut, ligne.date_fin);
    if (annoncee == null || reelle == null) continue;

    if (Math.abs(annoncee - reelle) > TOLERANCE_DUREE_MOIS) {
      issues.push({
        code: "PERIOD_DURATION_MISMATCH",
        severity: "error",
        message:
          `${etiquette} le libellé annonce ${annoncee} mois, mais les dates extraites ` +
          `(${ligne.date_debut} → ${ligne.date_fin}) en couvrent ${reelle.toFixed(2)} — ` +
          `une des deux lectures est fausse`,
        field: `charges[${index}].date_debut`,
        expected: annoncee,
        actual: Number(reelle.toFixed(2)),
        delta: Number((reelle - annoncee).toFixed(2)),
      });
    }
  }

  // 2b. Cohérence tarif_type ↔ postes tarifaires extraits.
  // HP/HC implique HPHC ; HPB/HCB/… implique TEMPO.
  {
    const HPHC_POSTES = new Set(["HP", "HC"]);
    const TEMPO_POSTES = new Set(["HPB", "HCB", "HPW", "HCW", "HPR", "HCR"]);
    const hasHPHC = consumption_lines.some((l) => HPHC_POSTES.has(normalizePosteTarifaire(l.poste_tarifaire)));
    const hasTEMPO = consumption_lines.some((l) => TEMPO_POSTES.has(normalizePosteTarifaire(l.poste_tarifaire)));
    if (hasHPHC && contract.tarif_type !== "HPHC") {
      issues.push({
        code: "TARIF_TYPE_MISMATCH",
        severity: "warning",
        message: `Lignes HP/HC présentes mais tarif_type = "${contract.tarif_type ?? "null"}" — devrait être "HPHC"`,
        field: "contract.tarif_type",
      });
    }
    if (hasTEMPO && contract.tarif_type !== "TEMPO") {
      issues.push({
        code: "TARIF_TYPE_MISMATCH",
        severity: "warning",
        message: `Lignes TEMPO (HPB/HCB/…) présentes mais tarif_type = "${contract.tarif_type ?? "null"}" — devrait être "TEMPO"`,
        field: "contract.tarif_type",
      });
    }
  }

  // 3. HP/HC même prix unitaire dans une même période.
  // Sur contrat HPHC EDF, HP est toujours plus cher que HC.
  // Même tarif pour les deux postes = l'OCR a probablement extrait le même prix pour HP et HC.
  {
    const pairMap = new Map<string, { hp?: number; hc?: number }>();
    for (const line of consumption_lines) {
      if (line.prix_unitaire_ckwh == null) continue;
      // Normaliser avant comparaison : "Heure P", "H.P.", etc. → "HP"
      const poste = normalizePosteTarifaire(line.poste_tarifaire);
      if (poste !== "HP" && poste !== "HC") continue;
      const key = `${line.date_debut ?? ""}|${line.date_fin ?? ""}`;
      const pair = pairMap.get(key) ?? {};
      if (poste === "HP") pair.hp = line.prix_unitaire_ckwh;
      else pair.hc = line.prix_unitaire_ckwh;
      pairMap.set(key, pair);
    }
    for (const [, pair] of pairMap) {
      if (pair.hp != null && pair.hc != null && Math.abs(pair.hp - pair.hc) < 0.001) {
        issues.push({
          code: "HPHC_SAME_PRICE",
          severity: "warning",
          message: `HP et HC ont le même prix unitaire (${pair.hp} c€/kWh) — l'OCR a peut-être extrait le même tarif pour les deux postes`,
        });
        break; // un seul avertissement par facture suffit
      }
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
