import type Anthropic from "@anthropic-ai/sdk";
import { OCR_MODEL } from "./client";

/**
 * Détection des frontières entre factures dans un PDF multi-pages.
 *
 * Pourquoi un appel dédié plutôt qu'une extraction élargie : le schéma d'extraction
 * (`invoice-schema.ts`) décrit UNE facture — un seul `facture_number`, un seul en-tête.
 * Lancé sur un scan qui en contient vingt, il en produit une seule et perd les autres
 * en silence. C'est exactement ce qui s'est produit en production : 14 factures créées
 * depuis des scans de 4 à 58 pages, chacune portant le total agrégé du lot (38 000 €
 * de moyenne contre 1 569 € pour une vraie facture).
 *
 * Cet appel ne fait donc QUE repérer les frontières — il n'extrait rien. Le découpage
 * physique et l'extraction se font ensuite, une facture à la fois, par le chemin normal.
 *
 * Ces scans d'archives n'ont aucune couche texte (vérifié : 0 caractère extractible
 * sur les 6 premières pages de chaque document testé). Aucune heuristique textuelle ne
 * peut les segmenter — seule la vision le peut, d'où le passage par le modèle.
 */

/**
 * Au-delà, un document est considéré comme potentiellement multi-factures et proposé à
 * l'analyse. En dessous, il part directement dans le chemin normal.
 *
 * Calibré sur les documents réels de la base : sur les 25 derniers imports aboutis,
 * 12 font 1 page et 12 en font 2 — seul un document dépasse (12 pages). À 5, aucune
 * facture unitaire normale ne déclenche l'analyse, donc ni coût ni friction sur le cas
 * courant, tout en attrapant les scans groupés (4 à 58 pages observées).
 *
 * Abaisser ce seuil rendrait l'import plus lent et plus cher sans rien gagner ; le
 * relever laisserait passer les scans les plus courts.
 */
export const MULTI_INVOICE_PAGE_THRESHOLD = 5;

/**
 * Plafond de pages envoyées au modèle en une fois.
 *
 * L'API accepte 600 pages par requête sur un modèle à contexte 1M (100 en dessous),
 * très au-delà des scans observés (58 pages au maximum). Ce plafond-ci est un garde-fou
 * de coût, pas une limite technique : une page scannée coûte environ 2 300 tokens en
 * vision, donc 150 pages ≈ 345 000 tokens sur un seul appel.
 */
export const MAX_PAGES_PER_DETECTION = 150;

export interface DetectedInvoice {
  /** Numéro de page de début, 1-indexé et inclusif. */
  start_page: number;
  /** Numéro de page de fin, 1-indexé et inclusif. */
  end_page: number;
  /** Numéro de facture lu sur le document, si lisible. */
  facture_number: string | null;
  /** Libellé court pour l'écran de confirmation (site, commune, période). */
  label: string | null;
}

export const invoiceSplitTool: Anthropic.Beta.BetaTool = {
  name: "detect_invoice_boundaries",
  description:
    "Déclare les plages de pages de chaque facture d'électricité individuelle contenue dans le document.",
  input_schema: {
    type: "object",
    properties: {
      invoices: {
        type: "array",
        description:
          "Une entrée par facture individuelle, dans l'ordre d'apparition. Les plages ne doivent ni se chevaucher ni laisser de trou.",
        items: {
          type: "object",
          properties: {
            start_page: { type: "integer", description: "Première page de la facture (1-indexé, inclusif)." },
            end_page: { type: "integer", description: "Dernière page de la facture (1-indexé, inclusif)." },
            facture_number: {
              type: ["string", "null"],
              description: "Numéro de facture s'il est lisible, sinon null. Ne jamais inventer.",
            },
            label: {
              type: ["string", "null"],
              description:
                "Libellé court identifiant la facture pour un humain : site, commune ou période. Maximum ~60 caractères.",
            },
          },
          required: ["start_page", "end_page", "facture_number", "label"],
          additionalProperties: false,
        },
      },
    },
    required: ["invoices"],
    additionalProperties: false,
  },
};

const SPLIT_SYSTEM_PROMPT = `Tu analyses un document PDF scanné qui peut contenir PLUSIEURS factures d'électricité EDF mises bout à bout (archives numérisées en lot).

Ta seule tâche : délimiter chaque facture individuelle par sa plage de pages. Tu n'extrais aucune donnée chiffrée.

Comment reconnaître le début d'une facture :
- Un en-tête EDF avec un nouveau numéro de facture, une nouvelle date d'émission, ou un nouveau point de livraison.
- Les pages suivantes d'une même facture (détail de consommation, taxes, mentions légales, conditions générales) appartiennent à CETTE facture, pas à une nouvelle.

Règles :
- Une facture EDF s'étend souvent sur 2 à 4 pages. Une page seule n'est une facture complète que si elle porte visiblement l'intégralité des informations.
- Les plages doivent couvrir tout le document, sans chevauchement ni trou : la page de fin d'une facture est immédiatement suivie de la page de début de la suivante.
- Si une page est une couverture, un bordereau récapitulatif ou un intercalaire sans facture, rattache-la à la facture qui la suit.
- Si le document ne contient en réalité qu'une seule facture, renvoie une seule plage couvrant tout le document.
- N'invente jamais un numéro de facture : mets null s'il n'est pas lisible.`;

/**
 * Requête de détection prête à passer à `messages.create()`.
 *
 * Le PDF est référencé par `file_id` (Files API) plutôt qu'inliné en base64 : ces scans
 * pèsent jusqu'à 11,5 Mo, très au-delà du plafond de corps de requête d'une Vercel
 * Function (4,5 Mo, fixe).
 */
export function buildSplitDetectionParams(
  fileId: string,
): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
  return {
    model: OCR_MODEL,
    // L'API Files n'existe que sur la surface beta ; la source `file` d'un bloc
    // `document` en dépend, d'où l'en-tête porté par la requête elle-même.
    betas: ["files-api-2025-04-14"],
    max_tokens: 4096,
    system: SPLIT_SYSTEM_PROMPT,
    tools: [invoiceSplitTool],
    tool_choice: { type: "tool", name: "detect_invoice_boundaries" },
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "file", file_id: fileId } },
          {
            type: "text",
            text: "Délimite chaque facture individuelle de ce document par sa plage de pages.",
          },
        ],
      },
    ],
  };
}

/**
 * Lit et valide la réponse du modèle contre le nombre de pages réel.
 *
 * Le modèle peut renvoyer des plages incohérentes (inversées, hors document, avec des
 * trous). Plutôt que de faire confiance, on normalise : bornes ramenées dans le
 * document, plages invalides écartées, tri par page de début, et rattachement des trous
 * à la plage précédente pour qu'aucune page ne soit perdue au découpage.
 */
export function parseDetectedInvoices(
  content: Anthropic.Beta.BetaContentBlock[],
  pageCount: number,
): DetectedInvoice[] {
  const toolUse = content.find(
    (block): block is Anthropic.Beta.BetaToolUseBlock =>
      block.type === "tool_use" && block.name === "detect_invoice_boundaries",
  );
  if (!toolUse) return [];

  const raw = (toolUse.input as { invoices?: unknown }).invoices;
  if (!Array.isArray(raw)) return [];

  const cleaned = raw
    .map((entry): DetectedInvoice | null => {
      if (typeof entry !== "object" || entry === null) return null;
      const record = entry as Record<string, unknown>;
      const start = Number(record.start_page);
      const end = Number(record.end_page);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      const startPage = Math.max(1, Math.min(pageCount, Math.trunc(start)));
      const endPage = Math.max(startPage, Math.min(pageCount, Math.trunc(end)));
      return {
        start_page: startPage,
        end_page: endPage,
        facture_number: typeof record.facture_number === "string" && record.facture_number.trim()
          ? record.facture_number.trim()
          : null,
        label: typeof record.label === "string" && record.label.trim()
          ? record.label.trim().slice(0, 80)
          : null,
      };
    })
    .filter((entry): entry is DetectedInvoice => entry !== null)
    .sort((a, b) => a.start_page - b.start_page);

  if (!cleaned.length) return [];

  // Recouvrement intégral : une page laissée hors de toute plage serait purement et
  // simplement perdue au découpage. Les chevauchements sont tranchés en faveur de la
  // plage précédente, les trous rattachés à elle aussi.
  const merged: DetectedInvoice[] = [];
  for (const entry of cleaned) {
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push({ ...entry, start_page: 1 });
      continue;
    }
    const startPage = Math.max(previous.end_page + 1, entry.start_page);
    if (startPage > pageCount) break;
    previous.end_page = startPage - 1;
    merged.push({ ...entry, start_page: startPage, end_page: Math.max(startPage, entry.end_page) });
  }
  const last = merged[merged.length - 1];
  if (last) last.end_page = pageCount;

  return merged;
}
