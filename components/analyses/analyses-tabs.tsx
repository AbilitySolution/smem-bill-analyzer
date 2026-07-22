"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { AnalysesView } from "./analyses-view";
import { CoverageView } from "./coverage-view";
import type { AnalysisData } from "@/lib/data/consumption";
import type { CoverageData } from "@/lib/data/coverage";

interface Commune { id: string; nom: string }
interface Site { id: string; nom: string; commune_id: string | null; categorie: string }
interface Filters { commune: string; site: string; cat: string }

const TABS = [
  { id: "conso", label: "Consommation" },
  { id: "couverture", label: "Couverture" },
] as const;

export function AnalysesTabs({
  analysis, coverage, communes, sites, filters,
}: {
  analysis: AnalysisData;
  coverage: CoverageData;
  communes: Commune[];
  sites: Site[];
  filters: Filters;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab: "conso" | "couverture" = searchParams.get("vue") === "couverture" ? "couverture" : "conso";

  function selectTab(t: "conso" | "couverture") {
    if (t === tab) return;
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set("vue", t);
    const next = params.toString();
    window.history.replaceState(null, "", `${pathname}${next ? `?${next}` : ""}`);
  }

  return (
    <div>
      <div className="border-b border-[var(--kn-border)] px-8">
        <div className="mx-auto flex max-w-6xl gap-1">
          {TABS.map((t) => {
            const on = tab === t.id;
            return (
              <button key={t.id} type="button" onClick={() => selectTab(t.id)}
                className={`relative px-4 py-3 text-[14px] font-medium transition-colors ${on ? "text-[var(--kn-text)]" : "text-[var(--kn-text-muted)] hover:text-[var(--kn-text)]"}`}>
                {t.label}
                {on && <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-[#f97316]" />}
              </button>
            );
          })}
        </div>
      </div>

      {tab === "conso"
        ? <AnalysesView analysis={analysis} communes={communes} sites={sites} filters={filters} />
        : <CoverageView data={coverage} />}
    </div>
  );
}
