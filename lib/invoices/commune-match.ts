// Rapprochement d'une commune à partir du texte extrait de la facture (indice commune, espace de
// livraison, adresse…). Score normalisé sur 0–1 (1 = correspondance exacte/incluse).
// Utilisé par /api/extract (suggestion, seuil 0.5) et l'auto-enregistrement (seuil 0.96).

export interface CommuneRef {
  id: string;
  nom: string;
}

export interface CommuneMatch {
  id: string;
  nom: string;
  score: number; // 0–1
}

const COMM_STOP = new Set(["de", "du", "la", "le", "les", "des", "l", "d", "en", "et", "a", "au"]);

function normalizeComm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .replace(/\bste\b/g, "sainte")
    .replace(/\bst\b/g, "saint")
    .replace(/\bsainte\b/g, "saint") // neutralise le genre : saint == sainte
    .replace(/\bgde?\b/g, "grand")
    .replace(/\bgrande\b/g, "grand")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulWords(normalized: string): string[] {
  return normalized.split(" ").filter((w) => w.length > 1 && !COMM_STOP.has(w));
}

function scoreOne(candidate: string, communeNom: string): number {
  const nc = normalizeComm(candidate);
  const nn = normalizeComm(communeNom);
  if (!nc || !nn) return 0;
  // Correspondance exacte / incluse → score plein.
  if (nc === nn || nc.includes(nn) || nn.includes(nc)) return 1;
  // Sinon, recouvrement des mots significatifs (hors mots vides).
  const cWords = new Set(meaningfulWords(nc));
  const nWords = meaningfulWords(nn);
  if (nWords.length === 0) return 0;
  const matches = nWords.filter((w) => cWords.has(w)).length;
  return matches / nWords.length;
}

/**
 * Retourne la meilleure commune correspondant à l'un des textes candidats, avec son score 0–1,
 * ou null si aucune commune / aucun candidat. Le seuil de décision est laissé à l'appelant.
 */
export function matchCommune(candidates: (string | null | undefined)[], communes: CommuneRef[]): CommuneMatch | null {
  const texts = candidates.filter((c): c is string => !!c && c.trim().length > 0);
  if (texts.length === 0 || communes.length === 0) return null;

  let best: CommuneMatch | null = null;
  for (const c of communes) {
    const score = Math.max(...texts.map((t) => scoreOne(t, c.nom)));
    if (!best || score > best.score) best = { id: c.id, nom: c.nom, score };
  }
  return best;
}
