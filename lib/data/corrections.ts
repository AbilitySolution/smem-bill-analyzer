import { createClient } from "@/lib/supabase/server";
import { getUserContext } from "@/lib/auth";

/**
 * Factures enregistrées automatiquement dont la lecture mérite un contrôle humain.
 *
 * Depuis que l'enregistrement automatique ne bloque plus les extractions incertaines
 * (`app/api/document-jobs/auto-save/route.ts`), une facture douteuse entre en base au
 * lieu de rester hors du système. C'est le bon choix à l'échelle — un dépôt de 300
 * factures ne peut pas attendre 300 relectures — mais il faut alors un endroit où ces
 * factures sont rattrapées. C'est cet écran.
 *
 * ── Ce qui entre ici, et pourquoi ────────────────────────────────────────────────
 *
 * 1. **Confiance d'extraction sous le seuil.** Calibré sur les données réelles : sur
 *    248 factures, 88 % dépassent 96 % de confiance et seules 5 % tombent sous 85 %.
 *    Un seuil à 85 % produit donc une liste courte — donc réellement traitée — là où
 *    96 % en enverrait 12 % et transformerait l'écran en corvée.
 *
 * 2. **Commune incertaine**, signalée par l'anomalie `low_confidence_auto_save`. C'est
 *    l'erreur la plus coûteuse du système : une facture rattachée au mauvais site
 *    fausse les analyses des deux sites, et se corrige mal une fois noyée dans le
 *    portefeuille.
 *
 * Le critère « champ obligatoire manquant » a été écarté après mesure : zéro facture
 * sur 248 en présente un. Le schéma d'extraction rend ces champs obligatoires, donc un
 * document qui ne les porte pas échoue AVANT d'atteindre la base — il finit `failed`
 * dans la file de traitement, pas ici.
 */

/** En deçà, la lecture est jugée incertaine. Voir le commentaire d'en-tête. */
export const CORRECTION_CONFIDENCE_THRESHOLD = 0.85;

export interface CorrectionItem {
  id: string;
  facture_number: string | null;
  facture_date: string | null;
  total_ttc: number | null;
  site_nom: string | null;
  commune_nom: string | null;
  file_path: string | null;
  confidence: number | null;
  /** Motifs lisibles : ce qui vaut à cette facture d'être ici. */
  reasons: string[];
}

interface RawRow {
  id: string;
  facture_number: string | null;
  facture_date: string | null;
  total_ttc: number | null;
  file_path: string | null;
  precision: Record<string, unknown> | null;
  sites: { nom: string } | { nom: string }[] | null;
  communes: { nom: string } | { nom: string }[] | null;
}

function firstOf<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

/**
 * Liste à corriger, la moins fiable en premier.
 *
 * Bornée à `pending_review` : une facture déjà relue (`reviewed`) ou signalée en
 * anomalie franche (`anomaly_flagged`) relève d'un autre écran. C'est ce qui empêche
 * cette page de se disputer les mêmes documents que la révision de dépôt.
 */
export async function getCorrectionItems(limit = 200): Promise<CorrectionItem[]> {
  const ctx = await getUserContext();
  if (!ctx) return [];
  const supabase = await createClient();

  const [{ data: invoices }, { data: flagged }] = await Promise.all([
    supabase
      .from("invoices")
      .select("id, facture_number, facture_date, total_ttc, file_path, precision, sites(nom), communes(nom)")
      .eq("org_id", ctx.orgId)
      .eq("archived", false)
      .eq("status", "pending_review")
      .eq("auto_saved", true)
      .order("facture_date", { ascending: false })
      .limit(limit),
    // Communes incertaines : posées par `saveInvoice` au moment de l'enregistrement
    // automatique, elles ne se lisent pas dans `precision`.
    supabase
      .from("anomalies")
      .select("invoice_id, description")
      .eq("type", "low_confidence_auto_save")
      .eq("resolved", false),
  ]);

  const flaggedById = new Map<string, string>(
    (flagged ?? []).map((row) => [row.invoice_id as string, (row.description as string) ?? ""]),
  );

  const items: CorrectionItem[] = [];
  for (const row of (invoices ?? []) as unknown as RawRow[]) {
    const rawConfidence = row.precision?._global;
    const confidence = typeof rawConfidence === "number" ? rawConfidence : null;
    const reasons: string[] = [];

    if (confidence !== null && confidence < CORRECTION_CONFIDENCE_THRESHOLD) {
      reasons.push(`Lecture incertaine (${Math.round(confidence * 100)} % de confiance)`);
    }
    if (flaggedById.has(row.id)) {
      reasons.push("Commune ou extraction signalée à l'enregistrement");
    }
    if (!reasons.length) continue;

    items.push({
      id: row.id,
      facture_number: row.facture_number,
      facture_date: row.facture_date,
      total_ttc: row.total_ttc,
      site_nom: firstOf(row.sites)?.nom ?? null,
      commune_nom: firstOf(row.communes)?.nom ?? null,
      file_path: row.file_path,
      confidence,
      reasons,
    });
  }

  // La moins fiable en tête : c'est là que le temps de relecture rapporte le plus.
  return items.sort((a, b) => (a.confidence ?? 1) - (b.confidence ?? 1));
}
