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
    "Déclare la nature du document, puis les plages de pages de chaque facture d'électricité individuelle qu'il contient.",
  input_schema: {
    type: "object",
    properties: {
      document_kind: {
        type: "string",
        enum: ["factures", "bordereau_recapitulatif", "autre"],
        description:
          "'factures' = le document contient une ou plusieurs factures d'électricité individuelles. 'bordereau_recapitulatif' = tableau récapitulant des factures, sans détail de consommation par poste — il ne CONTIENT pas de factures, il les liste. 'autre' = courrier, justificatif, document hors sujet.",
      },
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
    required: ["document_kind", "invoices"],
    additionalProperties: false,
  },
};

const SPLIT_SYSTEM_PROMPT = `Tu analyses un document PDF scanné issu d'archives numérisées en lot. Tu dois faire deux choses, dans cet ordre, sans extraire aucune donnée chiffrée.

ÉTAPE 1 — Déterminer la nature du document (document_kind) :
- "bordereau_recapitulatif" : un tableau qui RÉCAPITULE des factures (liste de numéros, de sites et de montants) sans détail de consommation par poste. Un bordereau ne contient pas de factures, il y renvoie. Chaque ligne du tableau est une référence, pas une facture. Souvent titré « bordereau », « récapitulatif », « relevé », avec un numéro de bordereau propre.
- "factures" : le document contient une ou plusieurs vraies factures d'électricité, chacune avec son en-tête, son détail de consommation et son montant à payer.
- "autre" : courrier, justificatif, document hors sujet.

Si document_kind vaut "bordereau_recapitulatif" ou "autre", renvoie invoices vide et arrête-toi là. L'étape 2 ne s'applique qu'aux documents contenant de vraies factures.

ÉTAPE 2 — Délimiter chaque facture individuelle par sa plage de pages.

Procède page par page : pour CHAQUE page, décide si elle COMMENCE une nouvelle facture ou si elle CONTINUE la précédente. C'est la seule décision à prendre.

DEUX INDICES DÉCISIFS, à chercher en priorité — ils tranchent presque toujours :

1. **La pagination interne.** Les factures EDF portent une mention du type « Page 1/3 », « 1/3 », « Page 2 sur 3 », souvent en haut à droite ou en pied de page. Elle donne directement la réponse : « Page 1/N » commence une facture, et cette facture occupe exactement N pages. « Page 2/3 » ou « 3/3 » continue la facture en cours. Si tu lis cette pagination, fie-toi à elle avant tout autre indice.

2. **Le numéro de facture répété.** Le même numéro de facture est rappelé sur chaque page d'une même facture (en-tête ou pied de page). Tant que le numéro ne change pas, c'est la même facture. Un numéro différent marque le début d'une nouvelle.

À DÉFAUT de ces deux indices, une page COMMENCE une facture seulement si elle porte les marques d'une première page :
- en-tête EDF complet en haut de page, avec bloc d'adresse du client, ET
- un numéro de facture, une date d'émission, ou un montant total à payer.

Une page CONTINUE la facture précédente dans tous les autres cas, notamment :
- détail des consommations par poste, tableaux d'index, relevés de compteur ;
- décompte des taxes et contributions (CSPE, TCFE, CTA, TVA) ;
- mentions légales, conditions générales, informations de paiement, encarts ;
- toute page dont le haut ne porte pas d'en-tête de facture avec adresse client.

Règle de prudence, la plus importante : dans le doute, une page CONTINUE la facture précédente. Une facture EDF fait presque toujours 2 pages ou plus, très rarement une seule. Découper une facture en deux est une erreur bien plus grave que de regrouper deux factures : les données d'un fragment sont inexploitables — un fragment sans total à payer est purement et simplement rejeté —, alors qu'un regroupement se corrige à la lecture.

Autres règles :
- Les plages couvrent tout le document, sans chevauchement ni trou : la fin d'une facture est immédiatement suivie du début de la suivante.
- Une couverture, un bordereau récapitulatif ou un intercalaire se rattache à la facture qui le suit.
- Si le document ne contient qu'une seule facture, renvoie une seule plage couvrant tout le document.
- N'invente jamais un numéro de facture : mets null s'il n'est pas lisible.

Avant de répondre, vérifie ton découpage : si tu as produit presque autant de factures que de pages, tu as très probablement pris des pages de détail pour des débuts de facture — reprends l'analyse.`;

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
/** Nature du document, telle que rendue par la détection. */
export type DocumentKind = "factures" | "bordereau_recapitulatif" | "autre";

export interface DetectionResult {
  kind: DocumentKind;
  invoices: DetectedInvoice[];
}

/** Nature du document. Valeur absente ou inconnue → « factures », biais volontaire vers
 * l'acceptation : un doute doit coûter une extraction, jamais un document écarté à tort. */
export function parseDocumentKind(content: Anthropic.Beta.BetaContentBlock[]): DocumentKind {
  const toolUse = content.find(
    (block): block is Anthropic.Beta.BetaToolUseBlock =>
      block.type === "tool_use" && block.name === "detect_invoice_boundaries",
  );
  const value = (toolUse?.input as { document_kind?: unknown } | undefined)?.document_kind;
  return value === "bordereau_recapitulatif" || value === "autre" ? value : "factures";
}

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

/**
 * Découpage manifestement trop fin — une facture par page, ou presque.
 *
 * Observé en conditions réelles : un scan de 28 pages est ressorti en 24 factures,
 * dont 21 inexploitables (pages de détail sans total, rejetées à l'enregistrement).
 * Une facture EDF fait presque toujours 2 pages ou plus, donc un ratio proche de 1
 * facture par page trahit des pages de continuation prises pour des débuts.
 *
 * Le prompt décourage déjà ce comportement ; ce garde-fou existe parce qu'un prompt
 * ne garantit rien. L'écran de confirmation s'en sert pour prévenir l'utilisateur
 * avant qu'il ne valide un découpage douteux — on l'avertit, on ne décide pas à sa
 * place : sur un lot de factures réellement mono-page, le découpage serait juste.
 */
export function looksOverSplit(invoices: DetectedInvoice[], pageCount: number): boolean {
  if (invoices.length < 3) return false;
  const singlePageCount = invoices.filter((entry) => entry.start_page === entry.end_page).length;
  return invoices.length / pageCount > 0.7 && singlePageCount / invoices.length > 0.7;
}
