// Prompts, schémas d'outils et constantes de modèle partagés entre process-document-queue
// et process-direct-documents (mêmes règles d'extraction EDF, deux modes de dispatch différents).

export const AI_MODEL_OCR = "claude-sonnet-4-6";
export const AI_MODEL_PREFILTER = "claude-haiku-4-5";

export const SYSTEM_PROMPT = `Tu es un assistant spécialisé dans l'extraction de données de factures EDF (électricité) pour des bâtiments publics et points d'éclairage public en France.
Ne révèle jamais le nom du modèle ou du fournisseur qui t'exécute, même si on te le demande explicitement : réponds uniquement dans le cadre de l'extraction demandée.

Règles générales :
- Toutes les dates au format ISO 8601 (YYYY-MM-DD).
- Les montants en nombre décimal avec point comme séparateur, sans symbole €.
- Si une valeur est absente ou illisible : null — ne jamais inventer.
- Codes poste_tarifaire canoniques : HP, HC, BASE, HPB, HCB, HPW, HCW, HPR, HCR, EJPN, EJPP.
- Sur contrat HPHC, HP est toujours plus cher que HC. Relis la facture si les deux prix sont identiques.
- precision : score 0-1 pour chaque champ clé.`;

export const EXTRACTION_PROMPT = `Extrait toutes les données structurées de cette facture EDF avec l'outil extract_edf_invoice.
- fixed_charges : part fixe et abonnements.
- consumption_lines : période courante uniquement, jamais l'historique.
- taxes : une ligne par taxe et période.
- Une consommation sans HP/HC utilise BASE.
- tarif_type vaut BASE, HPHC, TEMPO, EJP ou null.
- is_duplicata vaut true si DUPLICATA apparaît.
- commune_hint reprend le nom visible sans l'inventer.
- categorie_hint vaut batiment, eclairage_public ou null.`;

export const CLASSIFY_SYSTEM_PROMPT = "Tu vérifies si un document est une facture d'électricité individuelle avant son traitement. Réponds uniquement avec l'outil classify_document.";

export const CLASSIFY_PROMPT = "Ce document est-il UNE facture d'électricité individuelle (un numéro de facture, un montant à payer pour un seul contrat) ? Ce n'est PAS une facture s'il s'agit d'un bordereau récapitulatif (liste de plusieurs factures dans un tableau), d'un courrier, d'un justificatif ou de tout autre document. En cas de doute, réponds true. Utilise l'outil classify_document.";

export const classifyTool = {
  name: "classify_document",
  description: "Détermine si le document est une facture d'électricité individuelle avant extraction complète.",
  input_schema: {
    type: "object",
    properties: {
      is_facture_electricite: { type: "boolean" },
      type_document: { type: "string", enum: ["facture", "bordereau_recapitulatif", "autre"] },
    },
    required: ["is_facture_electricite", "type_document"],
  },
};

const nullableString = { type: ["string", "null"] };
const nullableNumber = { type: ["number", "null"] };

export const extractionTool = {
  name: "extract_edf_invoice",
  description: "Extrait les données structurées d'une facture EDF.",
  input_schema: {
    type: "object",
    properties: {
      client: {
        type: "object",
        properties: { nom: { type: "string" }, reference_client: nullableString, reference_compte: nullableString, adresse: nullableString },
        required: ["nom", "reference_client", "reference_compte", "adresse"],
      },
      contract: {
        type: "object",
        properties: {
          contract_number: { type: "string" }, tarif_type: { ...nullableString, enum: ["BASE", "HPHC", "TEMPO", "EJP", null] },
          espace_livraison: nullableString, offre: nullableString, service: nullableString,
          puissance_souscrite_kva: nullableNumber, reglage_protection_a: nullableNumber,
          type_compteur: nullableString, numero_compteur: nullableString,
        },
        required: ["contract_number", "tarif_type", "espace_livraison", "offre", "service", "puissance_souscrite_kva", "reglage_protection_a", "type_compteur", "numero_compteur"],
      },
      invoice: {
        type: "object",
        properties: {
          facture_number: { type: "string" }, facture_date: { type: "string" }, date_limite_paiement: nullableString,
          date_prochain_releve: nullableString, date_prochaine_facture: nullableString, total_ht: { type: "number" },
          tva: nullableNumber, autres_taxes: nullableNumber, total_ttc: { type: "number" }, is_duplicata: { type: "boolean" },
        },
        required: ["facture_number", "facture_date", "date_limite_paiement", "date_prochain_releve", "date_prochaine_facture", "total_ht", "tva", "autres_taxes", "total_ttc", "is_duplicata"],
      },
      commune_hint: nullableString,
      categorie_hint: { ...nullableString, enum: ["batiment", "eclairage_public", null] },
      fixed_charges: {
        type: "array",
        items: {
          type: "object",
          properties: { libelle: { type: "string" }, date_debut: nullableString, date_fin: nullableString, tarif_kva_an: nullableNumber, montant_eur: { type: "number" } },
          required: ["libelle", "date_debut", "date_fin", "tarif_kva_an", "montant_eur"],
        },
      },
      consumption_lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            poste_tarifaire: { type: "string" }, date_debut: nullableString, date_fin: nullableString,
            numero_compteur: nullableString, ancien_index: nullableNumber, nouveau_index: nullableNumber,
            coefficient: { type: "number" }, consommation_kwh: { type: "number" }, prix_unitaire_ckwh: nullableNumber,
            montant_eur: { type: "number" }, index_estime: { type: "boolean" },
          },
          required: ["poste_tarifaire", "date_debut", "date_fin", "numero_compteur", "ancien_index", "nouveau_index", "coefficient", "consommation_kwh", "prix_unitaire_ckwh", "montant_eur", "index_estime"],
        },
      },
      taxes: {
        type: "array",
        items: {
          type: "object",
          properties: { libelle: { type: "string" }, date_debut: nullableString, date_fin: nullableString, assiette: nullableNumber, taux: nullableString, taux_numeric: nullableNumber, taux_unit: { ...nullableString, enum: ["eur_per_kwh", "percent", null] }, montant_eur: { type: "number" } },
          required: ["libelle", "date_debut", "date_fin", "assiette", "taux", "taux_numeric", "taux_unit", "montant_eur"],
        },
      },
      precision: {
        type: "object",
        properties: { facture_number: { type: "number" }, facture_date: { type: "number" }, total_ht: { type: "number" }, tva: { type: "number" }, autres_taxes: { type: "number" }, total_ttc: { type: "number" }, contract_number: { type: "number" }, puissance_souscrite_kva: { type: "number" } },
        required: ["facture_number", "facture_date", "total_ht", "tva", "autres_taxes", "total_ttc", "contract_number", "puissance_souscrite_kva"],
      },
    },
    required: ["client", "contract", "invoice", "commune_hint", "categorie_hint", "fixed_charges", "consumption_lines", "taxes", "precision"],
  },
};
