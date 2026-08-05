import type { InvoiceExtraction } from "@/lib/anthropic/invoice-schema";

/**
 * Rapprochement d'une extraction avec le référentiel de l'organisation.
 *
 * Extrait de `app/api/extract/route.ts` sans changement de comportement, pour que
 * l'import en lot rapproche exactement comme l'import unitaire. Le scoring est pur
 * et testable ; seules les fonctions `match*` touchent la base.
 */

const COMM_STOP = new Set(["de", "du", "la", "le", "les", "des", "l", "d", "en", "et", "a", "au"]);

/** Minuscules, accents retirés, abréviations développées, genre neutralisé (saint == sainte). */
export function normalizeComm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD").replace(/\p{Mn}/gu, "")
    .replace(/\bste\b/g, "sainte")
    .replace(/\bst\b/g, "saint")
    .replace(/\bsainte\b/g, "saint") // neutralize gender: saint == sainte
    .replace(/\bgde?\b/g, "grand")
    .replace(/\bgrande\b/g, "grand")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ").trim();
}

function meaningfulWords(normalized: string): string[] {
  return normalized.split(" ").filter((w) => w.length > 1 && !COMM_STOP.has(w));
}

/** 100 pour une correspondance exacte ou incluse, sinon la part de mots significatifs retrouvés. */
export function scoreCommune(candidate: string, communeNom: string): number {
  const nc = normalizeComm(candidate);
  const nn = normalizeComm(communeNom);
  // Exact / substring match
  if (nc === nn || nc.includes(nn) || nn.includes(nc)) return 100;
  // Word-overlap on meaningful words only (ignore stop words)
  const cWords = new Set(meaningfulWords(nc));
  const nWords = meaningfulWords(nn);
  if (nWords.length === 0) return 0;
  const matches = nWords.filter((w) => cWords.has(w)).length;
  return matches / nWords.length;
}

/** Textes où chercher un nom de commune, du plus fiable au moins fiable. */
export function communeCandidates(extraction: InvoiceExtraction): string[] {
  return [
    extraction.commune_hint,
    extraction.contract.espace_livraison,
    extraction.client.adresse,
    extraction.client.nom,
  ].filter(Boolean) as string[];
}

/** Seuil en deçà duquel on préfère ne rien proposer plutôt que rattacher à la mauvaise commune. */
export const COMMUNE_MATCH_THRESHOLD = 0.5;

/** Meilleure commune parmi une liste déjà chargée. Pur — c'est la partie testable. */
export function pickBestCommune(
  candidates: string[],
  communes: Array<{ id: string; nom: string }>,
): { id: string; nom: string } | null {
  let bestScore = 0;
  let best: { id: string; nom: string } | null = null;
  for (const c of communes) {
    const s = Math.max(...candidates.map((h) => scoreCommune(h, c.nom)));
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return best && bestScore >= COMMUNE_MATCH_THRESHOLD ? best : null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function matchCommune(
  supabase: any,
  orgId: string,
  extraction: InvoiceExtraction,
): Promise<{ id: string; nom: string } | null> {
  const candidates = communeCandidates(extraction);
  if (!candidates.length) return null;

  const { data: allCommunes } = await supabase.from("communes").select("id, nom").eq("org_id", orgId);
  if (!allCommunes?.length) return null;

  return pickBestCommune(candidates, allCommunes as Array<{ id: string; nom: string }>);
}

/**
 * Site déjà rattaché au numéro de contrat, à condition qu'il soit dans la commune
 * retenue — un même numéro repris ailleurs ne doit pas rattacher au mauvais site.
 */
export async function matchSiteByContract(
  supabase: any,
  orgId: string,
  communeId: string,
  contractNumber: string | null,
): Promise<{ id: string; nom: string } | null> {
  if (!contractNumber) return null;

  const { data: existingContract } = await supabase
    .from("contracts")
    .select("site_id, sites(id, nom, commune_id)")
    .eq("org_id", orgId)
    .eq("contract_number", contractNumber)
    .maybeSingle();

  const rawSite = existingContract?.sites;
  const contractSite = Array.isArray(rawSite) ? rawSite[0] : rawSite;
  if (contractSite && (contractSite as { commune_id: string }).commune_id === communeId) {
    return { id: (contractSite as { id: string }).id, nom: (contractSite as { nom: string }).nom };
  }
  return null;
}
