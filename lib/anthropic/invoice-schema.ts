import { z } from "zod";

// Mirrors supabase/migrations/20260624000000_init_schema.sql.
// Claude OCR extraction must conform to this shape exactly (tool-use schema).

export const consumptionHistoryItemSchema = z.object({
  periode_label: z.string(),
  periode_date: z.string().nullable(),
  poste_tarifaire: z.string(),
  valeur_kwh: z.number().nullable(),
  is_estime: z.boolean(),
});

export const fixedChargeItemSchema = z.object({
  libelle: z.string(),
  date_debut: z.string().nullable(),
  date_fin: z.string().nullable(),
  tarif_kva_an: z.number().nullable(),
  montant_eur: z.number(),
});

export const consumptionLineItemSchema = z.object({
  poste_tarifaire: z.string(),
  date_debut: z.string().nullable(),
  date_fin: z.string().nullable(),
  numero_compteur: z.string().nullable(),
  ancien_index: z.number().nullable(),
  nouveau_index: z.number().nullable(),
  coefficient: z.number().default(1),
  consommation_kwh: z.number(),
  prix_unitaire_ckwh: z.number().nullable(),
  montant_eur: z.number(),
  index_estime: z.boolean().default(false),
});

export const taxItemSchema = z.object({
  libelle: z.string(),
  date_debut: z.string().nullable(),
  date_fin: z.string().nullable(),
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
  consumption_history: z.array(consumptionHistoryItemSchema),
  fixed_charges: z.array(fixedChargeItemSchema),
  consumption_lines: z.array(consumptionLineItemSchema),
  taxes: z.array(taxItemSchema),
  // Score de confiance 0-1 par champ clé, estimé par le modèle à l'extraction.
  precision: z.record(z.string(), z.number()).nullable().optional(),
});

export type InvoiceExtraction = z.infer<typeof invoiceExtractionSchema>;

// JSON Schema passed to Claude as a tool definition (Anthropic tool-use).
// Kept in sync manually with invoiceExtractionSchema above.
export const invoiceExtractionToolSchema = {
  name: "extract_edf_invoice",
  description:
    "Extrait les données structurées d'une facture EDF (client, contrat, en-tête facture, historique consommation, charges fixes, lignes de consommation, taxes).",
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
      consumption_history: {
        type: "array",
        items: {
          type: "object",
          properties: {
            periode_label: { type: "string" },
            periode_date: { type: ["string", "null"] },
            poste_tarifaire: { type: "string", description: "hp | hc | base | total" },
            valeur_kwh: { type: ["number", "null"] },
            is_estime: { type: "boolean" },
          },
          required: ["periode_label", "periode_date", "poste_tarifaire", "valeur_kwh", "is_estime"],
        },
      },
      fixed_charges: {
        type: "array",
        items: {
          type: "object",
          properties: {
            libelle: { type: "string" },
            date_debut: { type: ["string", "null"] },
            date_fin: { type: ["string", "null"] },
            tarif_kva_an: { type: ["number", "null"] },
            montant_eur: { type: "number" },
          },
          required: ["libelle", "date_debut", "date_fin", "tarif_kva_an", "montant_eur"],
        },
      },
      consumption_lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            poste_tarifaire: { type: "string" },
            date_debut: { type: ["string", "null"] },
            date_fin: { type: ["string", "null"] },
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
            "date_debut",
            "date_fin",
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
      taxes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            libelle: { type: "string" },
            date_debut: { type: ["string", "null"] },
            date_fin: { type: ["string", "null"] },
            assiette: { type: ["number", "null"] },
            taux: { type: ["string", "null"] },
            taux_numeric: { type: ["number", "null"] },
            taux_unit: { type: ["string", "null"], enum: ["eur_per_kwh", "percent", null] },
            montant_eur: { type: "number" },
          },
          required: [
            "libelle",
            "date_debut",
            "date_fin",
            "assiette",
            "taux",
            "taux_numeric",
            "taux_unit",
            "montant_eur",
          ],
        },
      },
      precision: {
        type: "object",
        description:
          "Score de confiance de l'extraction, entre 0 et 1, pour chaque champ clé de l'en-tête (1 = certain et parfaitement lisible ; plus bas = valeur incertaine, illisible ou déduite).",
        properties: {
          facture_number: { type: "number" },
          facture_date: { type: "number" },
          total_ht: { type: "number" },
          tva: { type: "number" },
          autres_taxes: { type: "number" },
          total_ttc: { type: "number" },
        },
        required: ["facture_number", "facture_date", "total_ht", "tva", "autres_taxes", "total_ttc"],
      },
    },
    required: [
      "client",
      "contract",
      "invoice",
      "consumption_history",
      "fixed_charges",
      "consumption_lines",
      "taxes",
      "precision",
    ],
  },
};
