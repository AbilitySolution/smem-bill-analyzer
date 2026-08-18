import { createClient } from "@/lib/supabase/server";
import { presentFields, fieldKey } from "@/lib/extraction/diff";
import type { InvoiceExtraction } from "@/lib/anthropic/invoice-schema";

export interface FieldQuality {
  /** Clé `table.colonne` — identifiant stable du champ. */
  key: string;
  label: string;
  /** Factures validées où ce champ avait une valeur à extraire. */
  extracted: number;
  /** Parmi elles, combien ont dû être corrigées à la main. */
  corrected: number;
  /** 1 - corrected/extracted. null si l'échantillon est trop petit pour être honnête. */
  precision: number | null;
}

export interface ExtractionQuality {
  /** Factures validées prises en compte (dénominateur global). */
  invoiceCount: number;
  /** Factures validées sans aucune correction humaine. */
  untouchedCount: number;
  /** Précision globale pondérée sur tous les champs mesurés. */
  overallPrecision: number | null;
  fields: FieldQuality[];
  /** Corrections journalisées mais dont le champ n'est pas dans la liste suivie. */
  otherCorrections: number;
  /** Factures relues nécessaires pour qu'un champ reçoive un taux. Transporté avec les
   *  données plutôt qu'importé : la vue est un composant client, et ce module dépend du
   *  client Supabase serveur. */
  minSample: number;
  isDemo?: boolean;
}

/** Sous les 5 factures, un taux n'a aucune valeur statistique — on préfère ne rien affirmer. */
const MIN_SAMPLE = 5;

/**
 * Champs suivis, dans l'ordre d'affichage. Volontairement restreint aux champs à enjeu
 * métier : afficher les 50 champs du schéma noierait le signal.
 */
const TRACKED_FIELDS: { key: string; label: string }[] = [
  { key: fieldKey("invoices", "total_ttc"), label: "Total TTC" },
  { key: fieldKey("invoices", "total_ht"), label: "Total HT" },
  { key: fieldKey("invoices", "tva"), label: "TVA" },
  { key: fieldKey("invoices", "facture_number"), label: "N° de facture" },
  { key: fieldKey("invoices", "facture_date"), label: "Date de facture" },
  { key: fieldKey("invoices", "date_limite_paiement"), label: "Échéance de paiement" },
  { key: fieldKey("consumption_periods", "consommation_kwh"), label: "Consommation (kWh)" },
  { key: fieldKey("consumption_periods", "prix_unitaire_ckwh"), label: "Prix unitaire (c€/kWh)" },
  { key: fieldKey("consumption_periods", "poste_tarifaire"), label: "Poste tarifaire" },
  { key: fieldKey("consumption_periods", "period_start"), label: "Début de période" },
  { key: fieldKey("consumption_periods", "period_end"), label: "Fin de période" },
  { key: fieldKey("consumption_periods", "ancien_index"), label: "Ancien index" },
  { key: fieldKey("consumption_periods", "nouveau_index"), label: "Nouvel index" },
  { key: fieldKey("contracts", "contract_number"), label: "N° de contrat" },
  { key: fieldKey("contracts", "tarif_type"), label: "Type de tarif" },
  { key: fieldKey("contracts", "puissance_souscrite_kva"), label: "Puissance souscrite (kVA)" },
  { key: fieldKey("clients", "nom"), label: "Nom du client" },
  { key: fieldKey("invoices", "categorie"), label: "Catégorie de site" },
  { key: fieldKey("invoice_charges", "montant_eur"), label: "Montant des charges/taxes" },
];

const TRACKED_KEYS = new Set(TRACKED_FIELDS.map((f) => f.key));

interface InvoiceRow {
  id: string;
  raw_ocr_json: unknown;
}
interface CorrectionRow {
  invoice_id: string;
  table_name: string;
  field_name: string;
}

/**
 * Précision réelle de l'extraction IA, mesurée sur les corrections humaines effectivement
 * effectuées (corrections_log) — pas une estimation du modèle sur lui-même.
 *
 * Ne compte que les factures **relues par un humain** (`auto_saved = false`) : tant que
 * personne n'a ouvert une facture champ par champ, on ne sait pas si l'extraction était
 * juste. Le statut `reviewed` ne suffit pas à l'établir — l'enregistrement automatique et
 * l'acceptation en bloc depuis le contrôle qualité l'écrivent tous deux sans qu'aucun œil
 * humain ne se soit posé sur les données. Les inclure ferait afficher une précision proche
 * de 100 %, entièrement auto-décernée.
 */
export async function getExtractionQuality(orgId: string): Promise<ExtractionQuality | null> {
  const supabase = await createClient();

  // Note d'échelle : on rapatrie raw_ocr_json pour savoir quels champs avaient une valeur à
  // extraire. Acceptable à quelques milliers de factures ; au-delà, basculer l'agrégation
  // dans une fonction SQL / vue matérialisée.
  const [{ data: invoices, error: invErr }, { data: corrections, error: corrErr }] = await Promise.all([
    supabase
      .from("invoices")
      .select("id, raw_ocr_json")
      .eq("org_id", orgId)
      .in("status", ["reviewed", "anomaly_flagged"])
      .eq("auto_saved", false),
    supabase
      .from("corrections_log")
      .select("invoice_id, table_name, field_name"),
  ]);

  if (invErr || corrErr || !invoices || invoices.length === 0) return null;

  // Une correction répétée sur le même champ d'une même facture ne compte qu'une fois :
  // on mesure « ce champ a-t-il dû être repris ? », pas le nombre de frappes.
  const correctedByField = new Map<string, Set<string>>();
  const invoiceIds = new Set(invoices.map((i) => (i as InvoiceRow).id));
  let otherCorrections = 0;
  const touchedInvoices = new Set<string>();

  for (const c of (corrections ?? []) as CorrectionRow[]) {
    if (!invoiceIds.has(c.invoice_id)) continue; // hors périmètre (RLS filtre déjà l'org)
    touchedInvoices.add(c.invoice_id);
    const key = fieldKey(c.table_name, c.field_name);
    if (!TRACKED_KEYS.has(key)) { otherCorrections++; continue; }
    if (!correctedByField.has(key)) correctedByField.set(key, new Set());
    correctedByField.get(key)!.add(c.invoice_id);
  }

  const extractedByField = new Map<string, number>();
  for (const row of invoices as InvoiceRow[]) {
    const raw = row.raw_ocr_json;
    if (!raw || typeof raw !== "object") continue;
    let present: Set<string>;
    try {
      present = presentFields(raw as InvoiceExtraction);
    } catch {
      continue; // extraction d'un ancien format : ignorée plutôt que de fausser le calcul
    }
    // Un champ corrigé compte au dénominateur même si l'humain l'a finalement vidé.
    for (const key of TRACKED_KEYS) {
      const wasCorrected = correctedByField.get(key)?.has(row.id) ?? false;
      if (present.has(key) || wasCorrected) {
        extractedByField.set(key, (extractedByField.get(key) ?? 0) + 1);
      }
    }
  }

  const fields: FieldQuality[] = TRACKED_FIELDS.map(({ key, label }) => {
    const extracted = extractedByField.get(key) ?? 0;
    const corrected = correctedByField.get(key)?.size ?? 0;
    return {
      key, label, extracted, corrected,
      precision: extracted >= MIN_SAMPLE ? 1 - corrected / extracted : null,
    };
  }).filter((f) => f.extracted > 0);

  const totalExtracted = fields.reduce((s, f) => s + f.extracted, 0);
  const totalCorrected = fields.reduce((s, f) => s + f.corrected, 0);

  return {
    invoiceCount: invoices.length,
    untouchedCount: invoices.length - touchedInvoices.size,
    overallPrecision: totalExtracted >= MIN_SAMPLE ? 1 - totalCorrected / totalExtracted : null,
    fields,
    otherCorrections,
    minSample: MIN_SAMPLE,
  };
}

/** Repli pour le preview hors connexion (RLS renverrait un ensemble vide). */
export const DEMO_EXTRACTION_QUALITY: ExtractionQuality = {
  isDemo: true,
  minSample: MIN_SAMPLE,
  invoiceCount: 214,
  untouchedCount: 158,
  overallPrecision: 0.947,
  otherCorrections: 12,
  fields: [
    { key: "invoices.total_ttc", label: "Total TTC", extracted: 214, corrected: 5, precision: 1 - 5 / 214 },
    { key: "invoices.total_ht", label: "Total HT", extracted: 214, corrected: 7, precision: 1 - 7 / 214 },
    { key: "invoices.tva", label: "TVA", extracted: 210, corrected: 9, precision: 1 - 9 / 210 },
    { key: "invoices.facture_number", label: "N° de facture", extracted: 214, corrected: 3, precision: 1 - 3 / 214 },
    { key: "invoices.facture_date", label: "Date de facture", extracted: 214, corrected: 4, precision: 1 - 4 / 214 },
    { key: "invoices.date_limite_paiement", label: "Échéance de paiement", extracted: 187, corrected: 21, precision: 1 - 21 / 187 },
    { key: "consumption_periods.consommation_kwh", label: "Consommation (kWh)", extracted: 214, corrected: 11, precision: 1 - 11 / 214 },
    { key: "consumption_periods.prix_unitaire_ckwh", label: "Prix unitaire (c€/kWh)", extracted: 206, corrected: 18, precision: 1 - 18 / 206 },
    { key: "consumption_periods.poste_tarifaire", label: "Poste tarifaire", extracted: 214, corrected: 14, precision: 1 - 14 / 214 },
    { key: "consumption_periods.period_start", label: "Début de période", extracted: 213, corrected: 8, precision: 1 - 8 / 213 },
    { key: "consumption_periods.period_end", label: "Fin de période", extracted: 213, corrected: 8, precision: 1 - 8 / 213 },
    { key: "consumption_periods.ancien_index", label: "Ancien index", extracted: 198, corrected: 16, precision: 1 - 16 / 198 },
    { key: "consumption_periods.nouveau_index", label: "Nouvel index", extracted: 198, corrected: 15, precision: 1 - 15 / 198 },
    { key: "contracts.contract_number", label: "N° de contrat", extracted: 214, corrected: 6, precision: 1 - 6 / 214 },
    { key: "contracts.tarif_type", label: "Type de tarif", extracted: 214, corrected: 12, precision: 1 - 12 / 214 },
    { key: "contracts.puissance_souscrite_kva", label: "Puissance souscrite (kVA)", extracted: 201, corrected: 19, precision: 1 - 19 / 201 },
    { key: "clients.nom", label: "Nom du client", extracted: 214, corrected: 9, precision: 1 - 9 / 214 },
    { key: "invoices.categorie", label: "Catégorie de site", extracted: 214, corrected: 23, precision: 1 - 23 / 214 },
    { key: "invoice_charges.montant_eur", label: "Montant des charges/taxes", extracted: 212, corrected: 13, precision: 1 - 13 / 212 },
  ],
};
