import type { InvoiceExtraction } from "@/lib/anthropic/invoice-schema";

/**
 * Une correction humaine sur un champ extrait par l'IA, prête à insérer dans corrections_log.
 * `table_name`/`field_name` reprennent les noms de colonnes en base (pas les noms du schéma
 * d'extraction) pour que les métriques agrègent les corrections de revue initiale ET les
 * ré-éditions post-enregistrement sous la même clé.
 */
export interface CorrectionEntry {
  table_name: string;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  /** Index de la ligne pour les tables enfants (consumption_periods / invoice_charges). */
  line_index?: number;
}

/** Schéma d'extraction → nom de colonne en base, quand ils diffèrent. */
const LINE_FIELD_TO_COLUMN: Record<string, string> = {
  date_debut: "period_start",
  date_fin: "period_end",
};

function toColumn(field: string): string {
  return LINE_FIELD_TO_COLUMN[field] ?? field;
}

/** Normalise pour comparaison : null/undefined/"" sont équivalents, nombres comparés par valeur. */
function serialize(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  return String(v);
}

function pushIfChanged(
  out: CorrectionEntry[],
  table: string,
  field: string,
  before: unknown,
  after: unknown,
  lineIndex?: number,
) {
  const oldValue = serialize(before);
  const newValue = serialize(after);
  if (oldValue === newValue) return;
  out.push({
    table_name: table,
    field_name: toColumn(field),
    old_value: oldValue,
    new_value: newValue,
    ...(lineIndex !== undefined ? { line_index: lineIndex } : {}),
  });
}

function diffObject(
  out: CorrectionEntry[],
  table: string,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  lineIndex?: number,
) {
  if (!before || !after) return;
  // Union des clés : couvre aussi un champ ajouté par l'humain que l'IA n'avait pas produit.
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    pushIfChanged(out, table, key, before[key], after[key], lineIndex);
  }
}

function diffArray(
  out: CorrectionEntry[],
  table: string,
  before: Record<string, unknown>[] | undefined,
  after: Record<string, unknown>[] | undefined,
) {
  const b = before ?? [];
  const a = after ?? [];
  // Lignes appariées par index : suffisant pour la mesure de précision (on veut le taux de
  // correction par champ, pas un suivi d'identité de ligne). Les lignes ajoutées ou
  // supprimées par l'humain ne sont volontairement pas comptées comme corrections de champ.
  for (let i = 0; i < Math.min(b.length, a.length); i++) {
    diffObject(out, table, b[i], a[i], i);
  }
}

/**
 * Compare l'extraction brute de l'IA à la version validée par l'humain.
 * Chaque écart = une correction, donc un point de vérité terrain sur la précision réelle.
 */
export function fieldKey(table: string, field: string): string {
  return `${table}.${field}`;
}

function collectPresent(out: Set<string>, table: string, obj: Record<string, unknown> | undefined) {
  if (!obj) return;
  for (const [key, value] of Object.entries(obj)) {
    if (serialize(value) !== null) out.add(fieldKey(table, toColumn(key)));
  }
}

/**
 * Champs effectivement renseignés dans une extraction, en clés `table.colonne`.
 * Sert de dénominateur aux métriques de précision : on ne peut juger la justesse d'un champ
 * que sur les factures où il avait une valeur à extraire.
 */
export function presentFields(extraction: InvoiceExtraction): Set<string> {
  const out = new Set<string>();

  collectPresent(out, "invoices", extraction.invoice as unknown as Record<string, unknown>);
  collectPresent(out, "clients", extraction.client as unknown as Record<string, unknown>);
  collectPresent(out, "contracts", extraction.contract as unknown as Record<string, unknown>);

  for (const line of extraction.consumption_lines ?? []) {
    collectPresent(out, "consumption_periods", line as unknown as Record<string, unknown>);
  }
  for (const line of [...(extraction.fixed_charges ?? []), ...(extraction.taxes ?? [])]) {
    collectPresent(out, "invoice_charges", line as unknown as Record<string, unknown>);
  }
  if (serialize(extraction.categorie_hint) !== null) out.add(fieldKey("invoices", "categorie"));

  return out;
}

export function diffExtraction(
  original: InvoiceExtraction,
  edited: InvoiceExtraction,
): CorrectionEntry[] {
  const out: CorrectionEntry[] = [];

  diffObject(out, "invoices", original.invoice, edited.invoice);
  diffObject(out, "clients", original.client, edited.client);
  diffObject(out, "contracts", original.contract, edited.contract);

  diffArray(out, "consumption_periods", original.consumption_lines, edited.consumption_lines);
  // fixed_charges et taxes atterrissent tous deux dans invoice_charges en base.
  diffArray(out, "invoice_charges", original.fixed_charges, edited.fixed_charges);
  diffArray(out, "invoice_charges", original.taxes, edited.taxes);

  pushIfChanged(out, "invoices", "categorie", original.categorie_hint, edited.categorie_hint);

  return out;
}
