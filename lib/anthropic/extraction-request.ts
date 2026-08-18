import type Anthropic from "@anthropic-ai/sdk";
import { OCR_MODEL } from "./client";
import { invoiceExtractionSchema, invoiceExtractionToolSchema, type InvoiceExtraction } from "./invoice-schema";

/**
 * Construction et lecture de la requête d'extraction OCR, partagées entre les deux
 * chemins qui l'utilisent : l'appel synchrone de `/api/extract` (une facture, réponse
 * immédiate) et l'API Message Batches (un lot, asynchrone, moitié prix).
 *
 * L'objet renvoyé par `buildExtractionParams` est un `MessageCreateParams` complet :
 * il se passe tel quel à `messages.create()` comme au champ `params` d'une requête de
 * batch. C'est ce qui garantit que les deux flux extraient exactement de la même façon.
 */

export const EXTRACTION_MEDIA_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type ExtractionMediaType = (typeof EXTRACTION_MEDIA_TYPES)[number];

export function isExtractionMediaType(v: string): v is ExtractionMediaType {
  return (EXTRACTION_MEDIA_TYPES as readonly string[]).includes(v);
}

// Règles générales déplacées en system prompt : plus stables, moins sensibles aux variations de mise en page.
export const SYSTEM_PROMPT = `Tu es un assistant spécialisé dans l'extraction de données de factures EDF (électricité) pour des bâtiments publics et points d'éclairage public en France.

Règles générales :
- Toutes les dates au format ISO 8601 (YYYY-MM-DD).
- Les montants en nombre décimal avec point comme séparateur (ex. 123.45), sans symbole €.
- Si une valeur est absente ou illisible : null — ne jamais inventer.
- Codes poste_tarifaire canoniques : HP, HC, BASE, HPB, HCB, HPW, HCW, HPR, HCR, EJPN, EJPP.
  Même si la facture écrit "Heure P", "Heures Pleines", "H.P." → utiliser "HP". Idem pour HC et les variantes TEMPO.
- Relever le prix unitaire imprimé sur chaque ligne, sans le déduire d'une autre ligne. Sur les contrats EDF Collectivités, HP et HC portent couramment le même prix : le compteur sépare les index, le tarif négocié reste unique. Deux lignes au même prix ne sont pas une erreur.
- precision : donner un score 0-1 pour chaque champ clé (1 = parfaitement lisible ; plus bas si flou, ambigu, déduit ou absent).

Classification (document_type) — à déterminer AVANT d'extraire :
- "facture" : facture d'électricité individuelle — un numéro de facture et un montant pour un contrat/point de livraison. Une facture EDF Collectivités ou d'éclairage public rattachée à un bordereau ou à une facturation groupée reste une facture individuelle.
- "bordereau_recapitulatif" : document qui ne fait que récapituler plusieurs factures dans un tableau, sans détail de consommation par poste.
- "autre" : courrier, justificatif, ou tout document qui n'est ni une facture ni un bordereau.
- En cas de doute, choisis "facture".
- Si document_type n'est pas "facture" : renseigne document_type puis remplis les autres champs avec des valeurs vides (chaînes vides, 0, false, null, tableaux vides) — ils seront ignorés.`;

// Instructions structurelles EDF dans le message user (contexte document spécifique à chaque facture).
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
- commune_hint : nom de commune tel qu'il apparaît sur la facture (adresse client, espace de livraison, en-tête). Texte brut sans normaliser. Null si absent.`;

/** 4096 tronquait les factures multi-périodes complexes. */
const MAX_TOKENS = 8192;

/**
 * Pas de `temperature` ici, et ce n'est pas un oubli.
 *
 * L'API la refuse sur les modèles récents — « `temperature` is deprecated for this model »,
 * erreur 400 sur Sonnet 5 et Opus 5, qui pilotent leur échantillonnage eux-mêmes. Ne pas
 * la réintroduire sans vérifier le modèle en vigueur dans `OCR_MODEL`.
 *
 * Le sujet mérite d'être documenté parce que le réglage compte. Sur Sonnet 4.6, où le
 * paramètre existait encore, 20 extractions du même scan de 2016 ont donné :
 *   - température 1,0 (défaut implicite) : 6 dates fausses sur 20 (« 14 mars 2010 »)
 *   - température 0                      : 2 sur 20
 *
 * Le défaut implicite de l'API était donc le pire réglage possible pour une extraction
 * structurée. Et même à 0, une lecture sur dix restait fausse : la variance d'échantillonnage
 * se réduit, elle ne disparaît pas. C'est pourquoi les contrôles de cohérence de
 * `invoice-validation.ts` restent la vraie protection, pas le réglage du modèle.
 */

/**
 * Paramètres de l'appel d'extraction pour un document encodé en base64.
 * Le bloc document précède le texte : c'est l'ordre recommandé pour les PDF.
 */
export function buildExtractionParams(
  base64: string,
  mediaType: ExtractionMediaType,
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  const documentBlock: Anthropic.Messages.ContentBlockParam =
    mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };

  return {
    model: OCR_MODEL,
    max_tokens: MAX_TOKENS,
    // Le préfixe outils + system (~3000 tokens : le schéma d'outil pèse l'essentiel) est
    // identique à chaque facture. Sans point de cache, il est retraité et refacturé à
    // chaque appel. L'ordre de rendu étant tools → system → messages, le marqueur posé
    // sur le bloc system couvre aussi les outils.
    //
    // Placement explicite, et non `cache_control` en racine : celui-ci viserait le
    // dernier bloc cacheable, donc APRÈS le document — une écriture de cache jetée à
    // chaque facture, puisque le PDF change à chaque fois.
    //
    // Rentable dès deux appels dans le TTL de 5 min (1,25× d'écriture + 0,1× de lecture
    // contre 2× sans cache). Le cache est indexé sur les octets du préfixe pour la clé
    // API, pas par utilisateur : n'importe quelle extraction réchauffe les suivantes.
    // Vérifiable via `usage.cache_read_input_tokens`, qui doit être non nul dès le 2e appel.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: [invoiceExtractionToolSchema],
    tool_choice: { type: "tool", name: "extract_edf_invoice" },
    messages: [
      {
        role: "user",
        content: [documentBlock, { type: "text", text: EXTRACTION_PROMPT }],
      },
    ],
  };
}

export type ParseExtractionResult =
  | { ok: true; data: InvoiceExtraction }
  | { ok: false; error: string; details?: unknown; documentType?: "bordereau_recapitulatif" | "autre" };

/**
 * Lit le `tool_use` de la réponse et le valide contre le schéma.
 *
 * Renvoie un résultat discriminé plutôt qu'une `NextResponse` : le chemin batch
 * traite des dizaines de réponses hors contexte HTTP et doit consigner l'échec sur
 * l'item concerné sans interrompre le lot.
 */
export function parseExtractionResponse(
  content: Array<Anthropic.Messages.ContentBlock>,
): ParseExtractionResult {
  const toolUse = content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    return { ok: false, error: "Claude n'a pas retourné d'extraction." };
  }

  // Verdict de classification rendu par l'appel d'extraction lui-même : un document
  // jugé non-facture n'est pas validé champ à champ (ses champs sont vides à dessein).
  const documentType = (toolUse.input as { document_type?: unknown } | null)?.document_type;
  if (documentType === "bordereau_recapitulatif" || documentType === "autre") {
    return {
      ok: false,
      documentType,
      error: documentType === "bordereau_recapitulatif"
        ? "Ce document est un bordereau récapitulatif, pas une facture individuelle."
        : "Ce document n'a pas été reconnu comme une facture d'électricité.",
    };
  }

  const parsed = invoiceExtractionSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    return { ok: false, error: "Extraction invalide.", details: parsed.error.format() };
  }

  return { ok: true, data: parsed.data };
}
