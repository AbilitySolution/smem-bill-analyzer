import { z } from "zod";

// Mirrors supabase/migrations/20260624030000_schema_v2_analytics.sql.
// Claude OCR extraction must conform to this shape exactly (tool-use schema).
//
// consumption_periods is the analytics fact table: one row per billed
// period with real kwh + cost. charges holds fixed-subscription and tax
// lines (category distinguishes them) — billing detail only, not used for
// time-series analysis.

export const consumptionPeriodItemSchema = z.object({
  poste_tarifaire: z.string(),
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
  numero_compteur: z.string().nullable(),
  ancien_index: z.number().nullable(),
  nouveau_index: z.number().nullable(),
  coefficient: z.number().default(1),
  consommation_kwh: z.number(),
  prix_unitaire_ckwh: z.number().nullable(),
  montant_eur: z.number(),
  index_estime: z.boolean().default(false),
});

export const chargeItemSchema = z.object({
  category: z.enum(["fixed", "tax"]),
  libelle: z.string(),
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
  assiette: z.number().nullable(),
  taux: z.string().nullable(),
  taux_numeric: z.number().nullable(),
  taux_unit: z.enum(["eur_per_kwh", "percent"]).nullable(),
  montant_eur: z.number(),
});

export const invoiceExtractionSchema = z.object({
  client: z.object({
    nom: z.string(),
    reference_client: z.string().nullable(),
    reference_compte: z.string().nullable(),
    adresse: z.string().nullable(),
  }),
  contract: z.object({
    contract_number: z.string(),
    espace_livraison: z.string().nullable(),
    offre: z.string().nullable(),
    service: z.string().nullable(),
    puissance_souscrite_kva: z.number().nullable(),
    reglage_protection_a: z.number().nullable(),
    type_compteur: z.string().nullable(),
    numero_compteur: z.string().nullable(),
  }),
  invoice: z.object({
    facture_number: z.string(),
    facture_date: z.string(),
    date_limite_paiement: z.string().nullable(),
    date_prochain_releve: z.string().nullable(),
    date_prochaine_facture: z.string().nullable(),
    total_ht: z.number(),
    tva: z.number().nullable(),
    autres_taxes: z.number().nullable(),
    total_ttc: z.number(),
    is_duplicata: z.boolean().default(false),
  }),
  consumption_periods: z.array(consumptionPeriodItemSchema),
  charges: z.array(chargeItemSchema),
});

export type InvoiceExtraction = z.infer<typeof invoiceExtractionSchema>;

// JSON Schema passed to Claude as a tool definition (Anthropic tool-use).
// Kept in sync manually with invoiceExtractionSchema above.
export const invoiceExtractionToolSchema = {
  name: "extract_edf_invoice",
  description:
    "Extrait les données structurées d'une facture EDF (client, contrat, en-tête facture, périodes de consommation facturées, charges fixes et taxes).",
  input_schema: {
    type: "object" as const,
    properties: {
      client: {
        type: "object",
        properties: {
          nom: { type: "string" },
          reference_client: { type: ["string", "null"] },
          reference_compte: { type: ["string", "null"] },
          adresse: { type: ["string", "null"] },
        },
        required: ["nom", "reference_client", "reference_compte", "adresse"],
      },
      contract: {
        type: "object",
        properties: {
          contract_number: { type: "string" },
          espace_livraison: { type: ["string", "null"] },
          offre: { type: ["string", "null"] },
          service: { type: ["string", "null"] },
          puissance_souscrite_kva: { type: ["number", "null"] },
          reglage_protection_a: { type: ["number", "null"] },
          type_compteur: { type: ["string", "null"] },
          numero_compteur: { type: ["string", "null"] },
        },
        required: [
          "contract_number",
          "espace_livraison",
          "offre",
          "service",
          "puissance_souscrite_kva",
          "reglage_protection_a",
          "type_compteur",
          "numero_compteur",
        ],
      },
      invoice: {
        type: "object",
        properties: {
          facture_number: { type: "string" },
          facture_date: { type: "string", description: "ISO 8601 YYYY-MM-DD" },
          date_limite_paiement: { type: ["string", "null"] },
          date_prochain_releve: { type: ["string", "null"] },
          date_prochaine_facture: { type: ["string", "null"] },
          total_ht: { type: "number" },
          tva: { type: ["number", "null"] },
          autres_taxes: { type: ["number", "null"] },
          total_ttc: { type: "number" },
          is_duplicata: { type: "boolean" },
        },
        required: [
          "facture_number",
          "facture_date",
          "date_limite_paiement",
          "date_prochain_releve",
          "date_prochaine_facture",
          "total_ht",
          "tva",
          "autres_taxes",
          "total_ttc",
          "is_duplicata",
        ],
      },
      consumption_periods: {
        type: "array",
        description:
          "Une ligne par période de barème facturée, avec index de compteur réels (section 'part variable' au verso de la facture). Ne pas inclure les tableaux d'historique/aperçu qui résument d'autres factures.",
        items: {
          type: "object",
          properties: {
            poste_tarifaire: { type: "string", description: "hp | hc | base" },
            period_start: { type: ["string", "null"] },
            period_end: { type: ["string", "null"] },
            numero_compteur: { type: ["string", "null"] },
            ancien_index: { type: ["number", "null"] },
            nouveau_index: { type: ["number", "null"] },
            coefficient: { type: "number" },
            consommation_kwh: { type: "number" },
            prix_unitaire_ckwh: { type: ["number", "null"] },
            montant_eur: { type: "number" },
            index_estime: { type: "boolean" },
          },
          required: [
            "poste_tarifaire",
            "period_start",
            "period_end",
            "numero_compteur",
            "ancien_index",
            "nouveau_index",
            "coefficient",
            "consommation_kwh",
            "prix_unitaire_ckwh",
            "montant_eur",
            "index_estime",
          ],
        },
      },
      charges: {
        type: "array",
        description:
          "Toutes les lignes 'part fixe / abonnement' (category=fixed) et 'taxes et contributions' (category=tax).",
        items: {
          type: "object",
          properties: {
            category: { type: "string", enum: ["fixed", "tax"] },
            libelle: { type: "string" },
            period_start: { type: ["string", "null"] },
            period_end: { type: ["string", "null"] },
            assiette: { type: ["number", "null"] },
            taux: { type: ["string", "null"] },
            taux_numeric: { type: ["number", "null"] },
            taux_unit: { type: ["string", "null"], enum: ["eur_per_kwh", "percent", null] },
            montant_eur: { type: "number" },
          },
          required: [
            "category",
            "libelle",
            "period_start",
            "period_end",
            "assiette",
            "taux",
            "taux_numeric",
            "taux_unit",
            "montant_eur",
          ],
        },
      },
    },
    required: ["client", "contract", "invoice", "consumption_periods", "charges"],
  },
};
