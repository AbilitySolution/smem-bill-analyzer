import { z } from "zod";

const num = z.number().nullable().transform((v) => v ?? 0);

export const fixedChargeItemSchema = z.object({
  libelle: z.string(),
  date_debut: z.string().nullable(),
  date_fin: z.string().nullable(),
  tarif_kva_an: z.number().nullable(),
  montant_eur: num,
});

export const consumptionLineItemSchema = z.object({
  poste_tarifaire: z.string(),
  date_debut: z.string().nullable(),
  date_fin: z.string().nullable(),
  numero_compteur: z.string().nullable(),
  ancien_index: z.number().nullable(),
  nouveau_index: z.number().nullable(),
  coefficient: z.number().nullable().transform((v) => v ?? 1),
  consommation_kwh: num,
  prix_unitaire_ckwh: z.number().nullable(),
  montant_eur: num,
  index_estime: z.boolean().nullable().transform((v) => v ?? false),
});

export const taxItemSchema = z.object({
  libelle: z.string(),
  date_debut: z.string().nullable(),
  date_fin: z.string().nullable(),
  assiette: z.number().nullable(),
  taux: z.string().nullable(),
  taux_numeric: z.number().nullable(),
  taux_unit: z.enum(["eur_per_kwh", "percent"]).nullable(),
  montant_eur: num,
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
    pdl: z.string().nullable(),
    tarif_type: z.enum(["BASE", "HPHC", "TEMPO", "EJP"]).nullable(),
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
    total_ht: num,
    tva: z.number().nullable(),
    autres_taxes: z.number().nullable(),
    total_ttc: num,
    is_duplicata: z.boolean().nullable().transform((v) => v ?? false),
  }),
  commune_hint: z.string().nullable(),
  categorie_hint: z.enum(["batiment", "eclairage_public"]).nullable().optional(),
  fixed_charges: z.array(fixedChargeItemSchema),
  consumption_lines: z.array(consumptionLineItemSchema),
  taxes: z.array(taxItemSchema),
  precision: z.record(z.string(), z.number()).nullable().optional(),
});

export type InvoiceExtraction = z.infer<typeof invoiceExtractionSchema>;

export const invoiceExtractionToolSchema = {
  name: "extract_edf_invoice",
  description:
    "Extrait les données structurées d'une facture EDF (client, contrat, en-tête facture, charges fixes, lignes de consommation, taxes).",
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
          pdl: {
            type: ["string", "null"],
            description: "Point De Livraison EDF — identifiant à 14 chiffres (ex: 12345678901234). Visible sur la facture, souvent libellé 'Réf. PDL' ou 'N° PDL'.",
          },
          tarif_type: {
            type: ["string", "null"],
            enum: ["BASE", "HPHC", "TEMPO", "EJP", null],
            description: "Type tarifaire normalisé : BASE (tarif unique), HPHC (heures pleines/creuses), TEMPO (jours bleus/blancs/rouges), EJP (effacement jours de pointe). Déduit depuis le champ 'offre' ou 'service'.",
          },
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
          "pdl",
          "tarif_type",
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
      commune_hint: {
        type: ["string", "null"],
        description: "Nom de la commune tel qu'il apparaît sur la facture (adresse client, espace de livraison, ou entête). Copier le texte exact trouvé sur la facture — ne pas normaliser. Null si absent.",
      },
      categorie_hint: {
        type: ["string", "null"],
        enum: ["batiment", "eclairage_public", null],
        description: "Type du point de livraison : 'eclairage_public' si la facture mentionne éclairage public, armoire, candélabre, luminaire, voirie ; 'batiment' sinon (mairie, salle, école, bâtiment administratif…). Null si impossible à déterminer.",
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
        description: `Lignes de consommation de la PÉRIODE COURANTE uniquement (section 'part variable'). NE PAS inclure l'historique de consommation (tableau récapitulatif hp/hc/base des périodes passées).

RÈGLES poste_tarifaire :
- Si la facture distingue 'HP'/'heures pleines' et 'HC'/'heures creuses' → une ligne HP et une ligne HC.
- Si la facture n'a qu'un seul poste ('consommations', 'base', ou aucun libellé HP/HC) → une seule ligne BASE.
- Si la consommation BASE est découpée par barème tarifaire (ex. 'consommations - barème du 01/07 au 31/07' et 'barème du 01/08 au ...') → créer UNE ligne par sous-période, poste_tarifaire='BASE', avec les dates et prix du barème.
- Tarifs normalisés : HP, HC, BASE, TEMPO_HP, TEMPO_HC, EJP_HP, EJP_HPN.`,
        items: {
          type: "object",
          properties: {
            poste_tarifaire: {
              type: "string",
              description: "HP | HC | BASE | TEMPO_HP | TEMPO_HC | EJP_HP | EJP_HPN. 'consommations' sans distinction HP/HC = BASE. Libellé exact si valeur inconnue.",
            },
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
          "Score de confiance 0-1 par champ clé (1 = certain et parfaitement lisible ; plus bas = flou, ambigu, déduit ou absent).",
        properties: {
          facture_number: { type: "number" },
          facture_date: { type: "number" },
          total_ht: { type: "number" },
          tva: { type: "number" },
          autres_taxes: { type: "number" },
          total_ttc: { type: "number" },
          pdl: { type: "number" },
          contract_number: { type: "number" },
          puissance_souscrite_kva: { type: "number" },
        },
        required: [
          "facture_number",
          "facture_date",
          "total_ht",
          "tva",
          "autres_taxes",
          "total_ttc",
          "pdl",
          "contract_number",
          "puissance_souscrite_kva",
        ],
      },
    },
    required: [
      "client",
      "contract",
      "invoice",
      "commune_hint",
      "categorie_hint",
      "fixed_charges",
      "consumption_lines",
      "taxes",
      "precision",
    ],
  },
};
