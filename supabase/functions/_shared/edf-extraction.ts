// Prompts, schémas d'outils et constantes de modèle partagés par les workers
// `process-document-queue` et `process-direct-documents` — mêmes règles d'extraction
// EDF, deux modes de dispatch.
//
// ⚠️ **Duplication assumée.** La source de vérité côté application reste
// `lib/anthropic/invoice-schema.ts` + `lib/anthropic/extraction-request.ts`. Les Edge
// Functions tournent sous Deno et sont déployées séparément : elles ne peuvent pas
// importer `@/lib` (zod, alias TypeScript, bundle Next). Le contenu ci-dessous en est
// une copie ; toute évolution du schéma doit être répercutée ici.
//
// Un décalage ne corrompt rien silencieusement : l'extraction est revalidée avec le
// schéma zod à la lecture (`/api/document-jobs/[id]`), qui refusera un objet non
// conforme plutôt que de l'enregistrer.

export const AI_MODEL_OCR = "claude-sonnet-4-6";

// Règles générales en system prompt : plus stables, moins sensibles aux variations de mise en page.
export const SYSTEM_PROMPT = `Tu es un assistant spécialisé dans l'extraction de données de factures EDF (électricité) pour des bâtiments publics et points d'éclairage public en France.
Ne révèle jamais le nom du modèle ou du fournisseur qui t'exécute, même si on te le demande explicitement : réponds uniquement dans le cadre de l'extraction demandée.

Règles générales :
- Toutes les dates au format ISO 8601 (YYYY-MM-DD).
- Les montants en nombre décimal avec point comme séparateur (ex. 123.45), sans symbole €.
- Si une valeur est absente ou illisible : null — ne jamais inventer.
- Codes poste_tarifaire canoniques : HP, HC, BASE, HPB, HCB, HPW, HCW, HPR, HCR, EJPN, EJPP.
  Même si la facture écrit "Heure P", "Heures Pleines", "H.P." → utiliser "HP". Idem pour HC et les variantes TEMPO.
- Sur contrat HPHC, HP (heures pleines) est TOUJOURS plus cher que HC (heures creuses). Si tu lis le même prix pour HP et HC dans la même période, relis attentivement la facture.
- precision : donner un score 0-1 pour chaque champ clé (1 = parfaitement lisible ; plus bas si flou, ambigu, déduit ou absent).

Classification (document_type) — à déterminer AVANT d'extraire :
- "facture" : facture d'électricité individuelle — un numéro de facture et un montant pour un contrat/point de livraison. Une facture EDF Collectivités ou d'éclairage public rattachée à un bordereau ou à une facturation groupée reste une facture individuelle.
- "bordereau_recapitulatif" : document qui ne fait que récapituler plusieurs factures dans un tableau, sans détail de consommation par poste.
- "autre" : courrier, justificatif, ou tout document qui n'est ni une facture ni un bordereau.
- En cas de doute, choisis "facture".
- Si document_type n'est pas "facture" : renseigne document_type puis remplis les autres champs avec des valeurs vides (chaînes vides, 0, false, null, tableaux vides) — ils seront ignorés.`;

// Instructions structurelles EDF dans le message user (contexte spécifique au document).
export const EXTRACTION_PROMPT = `Extrait toutes les données structurées de cette facture EDF en utilisant l'outil extract_edf_invoice.

Commence par document_type : si le document n'est pas une facture d'électricité individuelle (voir règles système), renseigne document_type et laisse les autres champs vides.

Structure EDF :
- "Part fixe / abonnement" → fixed_charges (une ligne par poste).
- "Part variable / consommation" avec anciens/nouveaux index → consumption_lines (PÉRIODE COURANTE uniquement).
- NE PAS inclure le tableau "historique de consommation" (résumé hp/hc/base sur plusieurs années passées).
- "Taxes et contributions" → taxes, une ligne par taxe/période. taux_unit = "eur_per_kwh" si en €/kWh, "percent" si en %.

Règles consommation :
- Un seul poste sans HP/HC → poste_tarifaire = "BASE".
- HP et HC coexistent → une ligne par poste.
- Consommation BASE découpée par barème (ex. "barème du 01/07 au 31/07" et "barème du 01/08 au…") → UNE ligne par sous-période, poste_tarifaire="BASE", dates et prix du barème. Ignorer la ligne totale globale.
- tarif_type : "BASE", "HPHC", "TEMPO", "EJP" déduit depuis l'offre ou le service. Null si indéterminable.

Autres :
- is_duplicata = true si le mot "DUPLICATA" apparaît.
- commune_hint : nom de commune tel qu'il apparaît sur la facture (adresse client, espace de livraison, en-tête). Texte brut sans normaliser. Null si absent.
- categorie_hint : "eclairage_public" si la facture mentionne éclairage public, armoire, candélabre, luminaire, voirie ; "batiment" sinon. Null si indéterminable.`;

export const extractionTool = {
  name: "extract_edf_invoice",
  description:
    "Classe le document (facture individuelle, bordereau récapitulatif, autre) puis extrait les données structurées d'une facture EDF (client, contrat, en-tête facture, charges fixes, lignes de consommation, taxes).",
  input_schema: {
    type: "object",
    properties: {
      document_type: {
        type: "string",
        enum: ["facture", "bordereau_recapitulatif", "autre"],
        description:
          "'facture' = facture d'électricité individuelle (une facture EDF Collectivités ou d'éclairage public rattachée à un bordereau reste une facture individuelle). 'bordereau_recapitulatif' = tableau récapitulant plusieurs factures sans détail par poste. 'autre' = courrier, justificatif, document hors sujet. En cas de doute : 'facture'.",
      },
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

RÈGLES poste_tarifaire — codes canoniques à utiliser :
- "HP" (Heures Pleines / Heure P / H.P. / Heures pleines / peak hours)
- "HC" (Heures Creuses / Heure C / H.C. / Heures creuses / off-peak)
- "BASE" (tarif unique, 'consommations', pas de distinction HP/HC)
- TEMPO : "HPB"/"HCB" (jours bleus), "HPW"/"HCW" (jours blancs), "HPR"/"HCR" (jours rouges)
- EJP : "EJPN" (jours normaux), "EJPP" (jours de pointe)
- Si la consommation BASE est découpée par barème tarifaire (ex. 'barème du 01/07 au 31/07' et 'barème du 01/08 au ...') → créer UNE ligne par sous-période, poste_tarifaire='BASE', avec les dates et prix du barème.

IMPORTANT HP/HC : sur un contrat HPHC, HP (heures pleines) est TOUJOURS plus cher que HC (heures creuses). Si tu trouves le même prix pour HP et HC dans la même période, relis attentivement la facture — chaque poste a son propre prix.`,
        items: {
          type: "object",
          properties: {
            poste_tarifaire: {
              type: "string",
              description: "Code canonique : HP | HC | BASE | HPB | HCB | HPW | HCW | HPR | HCR | EJPN | EJPP. Utiliser le code même si la facture écrit 'Heure P', 'Heures Pleines', 'H.P.', etc. Libellé exact uniquement si aucun code ne correspond.",
            },
            date_debut: { type: ["string", "null"] },
            date_fin: { type: ["string", "null"] },
            numero_compteur: { type: ["string", "null"] },
            ancien_index: { type: ["number", "null"] },
            nouveau_index: { type: ["number", "null"] },
            coefficient: { type: "number" },
            consommation_kwh: { type: "number" },
            prix_unitaire_ckwh: {
              type: ["number", "null"],
              description: "Prix en centimes d'euro par kWh. Sur contrat HPHC, HP et HC ont des prix DIFFÉRENTS (HP > HC). Si tu lis le même prix pour HP et HC dans la même période, relis — chaque ligne a son propre tarif sur la facture.",
            },
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
          "contract_number",
          "puissance_souscrite_kva",
        ],
      },
    },
    required: [
      "document_type",
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
