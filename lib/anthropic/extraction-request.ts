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
- Sur contrat HPHC, HP (heures pleines) est TOUJOURS plus cher que HC (heures creuses). Si tu lis le même prix pour HP et HC dans la même période, relis attentivement la facture.
- precision : donner un score 0-1 pour chaque champ clé (1 = parfaitement lisible ; plus bas si flou, ambigu, déduit ou absent).`;

// Instructions structurelles EDF dans le message user (contexte document spécifique à chaque facture).
export const EXTRACTION_PROMPT = `Extrait toutes les données structurées de cette facture EDF en utilisant l'outil extract_edf_invoice.

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
    system: SYSTEM_PROMPT,
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
  | { ok: false; error: string; details?: unknown };

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

  const parsed = invoiceExtractionSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    return { ok: false, error: "Extraction invalide.", details: parsed.error.format() };
  }

  return { ok: true, data: parsed.data };
}
