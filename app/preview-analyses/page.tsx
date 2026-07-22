// TEMP — vérification visuelle (hors auth). À supprimer après contrôle.
import { AbilitySidebar } from "@/components/koncile/kn-sidebar";
import { AnalysesTabs } from "@/components/analyses/analyses-tabs";
import { DEMO_CONSUMPTION } from "@/lib/data/consumption";
import { DEMO_COVERAGE } from "@/lib/data/coverage";

export default function PreviewAnalysesPage() {
  return (
    <div className="flex h-screen bg-[var(--kn-page)] text-[var(--kn-text)]">
      <AbilitySidebar user={{ email: "demo@ability.fr", roleLabel: "Admin SMEM" }} isAdmin />
      <div className="min-w-0 flex-1 overflow-y-auto">
        <AnalysesTabs analysis={DEMO_CONSUMPTION} coverage={DEMO_COVERAGE} communes={[]} sites={[]} filters={{ commune: "", site: "", cat: "" }} />
      </div>
    </div>
  );
}
