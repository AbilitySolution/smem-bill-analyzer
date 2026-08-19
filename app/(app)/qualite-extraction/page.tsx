import { requireRole } from "@/lib/auth-guard";
import { getExtractionQuality, DEMO_EXTRACTION_QUALITY } from "@/lib/data/extraction-quality";
import { ExtractionQualityView } from "@/components/qualite/extraction-quality-view";

/**
 * Qualité d'extraction — réservée au Superviseur et à l'Administrateur.
 *
 * L'ancien repli « pas de session -> données de démo » a été retiré : dans le groupe
 * (app) la session est garantie par le layout, ce repli ne pouvait donc se déclencher
 * que sur un état anormal, et il affichait alors des chiffres plausibles là où on
 * attendait un refus. Le repli sur DEMO_EXTRACTION_QUALITY ne subsiste que pour une
 * organisation légitime dont la requête ne renvoie rien (aucune facture traitée) —
 * il n'y a alors ni fuite ni ambiguïté sur l'identité du lecteur.
 */
export default async function QualiteExtractionPage() {
  const ctx = await requireRole("org_supervisor");

  const quality = await getExtractionQuality(ctx.orgId);
  return <ExtractionQualityView data={quality ?? DEMO_EXTRACTION_QUALITY} />;
}
