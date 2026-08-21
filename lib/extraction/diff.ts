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

/* ------------------------------------------------------------------ *
 * Corrections post-enregistrement (éditeur `/documents/extraction`)
 * ------------------------------------------------------------------ */

/**
 * Colonnes que l'humain peut modifier, par table.
 *
 * Le diff ci-dessous compare deux lignes de base : sans cette liste, les colonnes techniques
 * (`id`, `invoice_id`, `created_at`, `org_id`…) apparaîtraient comme des corrections et
 * noieraient le signal. Doit rester alignée sur le schéma accepté par
 * `PATCH /api/invoices/[id]`.
 */
const EDITABLE_COLUMNS: Record<string, readonly string[]> = {
  invoices: [
    "facture_number", "facture_date", "date_limite_paiement",
    "total_ht", "tva", "autres_taxes", "total_ttc", "is_duplicata", "categorie",
  ],
  clients: ["nom", "reference_client", "reference_compte", "adresse"],
  contracts: [
    "contract_number", "tarif_type", "espace_livraison", "offre", "service",
    "puissance_souscrite_kva", "reglage_protection_a", "type_compteur", "numero_compteur",
  ],
  consumption_periods: [
    "poste_tarifaire", "period_start", "period_end", "numero_compteur",
    "ancien_index", "nouveau_index", "coefficient", "consommation_kwh",
    "prix_unitaire_ckwh", "montant_eur", "index_estime",
  ],
  invoice_charges: [
    "category", "libelle", "period_start", "period_end",
    "assiette", "taux", "taux_numeric", "taux_unit", "tarif_kva_an", "montant_eur",
  ],
};

type Row = Record<string, unknown>;

function diffColumns(out: CorrectionEntry[], table: string, before: Row, after: Row, lineIndex?: number) {
  for (const column of EDITABLE_COLUMNS[table] ?? []) {
    pushIfChanged(out, table, column, before[column], after[column], lineIndex);
  }
}

/** Clé d'appariement des périodes de consommation : ce qui identifie une ligne pour un humain. */
function consumptionKey(row: Row): string {
  return `${serialize(row.poste_tarifaire) ?? ""}|${serialize(row.period_start) ?? ""}`;
}

/** Clé d'appariement des charges : le libellé, seul identifiant naturel dont elles disposent. */
function chargeKey(row: Row): string {
  return `${serialize(row.category) ?? ""}|${serialize(row.libelle) ?? ""}`;
}

/**
 * Apparie deux jeux de lignes enfants par clé métier plutôt que par index.
 *
 * L'éditeur supprime puis réinsère les lignes enfants à chaque enregistrement : leur `id` ne
 * survit pas, et leur ordre de retour n'est pas garanti. Comparer par position produirait de
 * fausses corrections dès qu'une ligne est ajoutée, retirée ou remontée. Les lignes sans
 * correspondance des deux côtés sont ignorées — comme dans `diffArray`, un ajout ou une
 * suppression n'est pas une correction de champ.
 */
function diffChildRows(
  out: CorrectionEntry[],
  table: string,
  before: Row[],
  after: Row[],
  keyOf: (row: Row) => string,
) {
  const byKey = new Map<string, Row>();
  for (const row of before) {
    // Première occurrence gardée : sur clé dupliquée, mieux vaut comparer une paire stable
    // que d'écraser avec une ligne arbitraire.
    if (!byKey.has(keyOf(row))) byKey.set(keyOf(row), row);
  }
  after.forEach((row, index) => {
    const match = byKey.get(keyOf(row));
    if (match) diffColumns(out, table, match, row, index);
  });
}

/** Facture telle qu'elle existe en base, ou telle que l'éditeur la soumet. */
export interface InvoiceSnapshot {
  invoice: Row;
  client: Row;
  contract: Row;
  consumption: Row[];
  charges: Row[];
}

/**
 * Écarts entre la facture enregistrée et la version que l'humain vient de soumettre.
 *
 * Pendant qu'il compare l'extraction brute à la version validée avant enregistrement,
 * `diffExtraction` ne couvre que la revue initiale. Or l'enregistrement automatique écrit
 * directement la sortie du modèle en base : une facture jamais rouverte contient donc
 * exactement ce que l'IA a lu, et le premier passage dans l'éditeur mesure sa précision
 * réelle. Les deux côtés sont ici déjà en noms de colonnes, aucune traduction n'est requise.
 */
export function diffInvoiceSnapshot(before: InvoiceSnapshot, after: InvoiceSnapshot): CorrectionEntry[] {
  const out: CorrectionEntry[] = [];

  diffColumns(out, "invoices", before.invoice, after.invoice);
  diffColumns(out, "clients", before.client, after.client);
  diffColumns(out, "contracts", before.contract, after.contract);

  diffChildRows(out, "consumption_periods", before.consumption, after.consumption, consumptionKey);
  diffChildRows(out, "invoice_charges", before.charges, after.charges, chargeKey);

  return out;
}
