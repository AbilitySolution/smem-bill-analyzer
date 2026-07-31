import { getUserContext } from "@/lib/auth";
import { getExtractionQuality, DEMO_EXTRACTION_QUALITY } from "@/lib/data/extraction-quality";
import { ExtractionQualityView } from "@/components/qualite/extraction-quality-view";

export default async function QualiteExtractionPage() {
  const ctx = await getUserContext();
  // Hors session valide, RLS renverrait un ensemble vide : on montre le repli démo.
  if (!ctx) return <ExtractionQualityView data={DEMO_EXTRACTION_QUALITY} />;

  const quality = await getExtractionQuality(ctx.orgId);
  return <ExtractionQualityView data={quality ?? DEMO_EXTRACTION_QUALITY} />;
}
