import { CoverageView } from "@/components/analyses/coverage-view";
import { getCoverageData, DEMO_COVERAGE } from "@/lib/data/coverage";

export default async function CoverageAnalysisPage() {
  let coverage = null;

  try {
    coverage = await getCoverageData();
  } catch {
    coverage = null;
  }

  return <CoverageView data={coverage ?? DEMO_COVERAGE} />;
}
