import { getUserContext } from "@/lib/auth";
import { CoverageView } from "@/components/analyses/coverage-view";
import { getCoverageData, DEMO_COVERAGE, type CoverageData } from "@/lib/data/coverage";

export default async function CoverageAnalysisPage() {
  const ctx = await getUserContext();

  // Pas de session valide (preview public/hors connexion) → données de démo directement.
  if (!ctx) return <CoverageView data={DEMO_COVERAGE} />;

  let coverage: CoverageData | null = null;
  try {
    coverage = await getCoverageData({ orgId: ctx.orgId });
  } catch {
    coverage = null;
  }

  return <CoverageView data={coverage ?? DEMO_COVERAGE} />;
}
