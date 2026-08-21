import { requireRole } from "@/lib/auth-guard";
import { getExtractionQuality, DEMO_EXTRACTION_QUALITY } from "@/lib/data/extraction-quality";
import { ExtractionQualityView } from "@/components/qualite/extraction-quality-view";

/**
 * Qualité d'extraction — onglet de la page Documentation, réservé au Superviseur
 * et à l'Administrateur.
 *
 * La garde de rôle est conservée telle quelle en déménageant depuis /qualite-extraction :
 * `/documentation` est déjà `org_supervisor` dans ROUTE_RULES, mais la page ne s'en remet
 * pas au préfixe — une page réservée porte sa propre garde, sinon un simple déplacement
 * d'arborescence suffirait à l'ouvrir.
 *
 * Le repli sur DEMO_EXTRACTION_QUALITY ne subsiste que pour une organisation légitime
 * dont la requête ne renvoie rien (aucune facture traitée).
 */
export default async function QualiteExtractionPage() {
  const ctx = await requireRole("org_supervisor");

  const quality = await getExtractionQuality(ctx.orgId);
  return <ExtractionQualityView data={quality ?? DEMO_EXTRACTION_QUALITY} />;
}
