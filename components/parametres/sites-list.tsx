"use client";

import { useMemo, useState } from "react";
import { Building2, Lightbulb, MapPin, Search } from "lucide-react";
import { Input } from "@/components/ui/input";

export interface SiteAffiche {
  id: string;
  nom: string;
  categorie: "batiment" | "eclairage_public";
  pdl: string | null;
  kva: number | null;
  ampere: number | null;
  commune: string;
  communeArchivee: boolean;
}

type Filtre = "tous" | SiteAffiche["categorie"];

const filtres: { value: Filtre; label: string }[] = [
  { value: "tous", label: "Tous" },
  { value: "batiment", label: "Bâtiments" },
  { value: "eclairage_public", label: "Éclairage public" },
];

export function SitesList({ sites }: { sites: SiteAffiche[] }) {
  const [recherche, setRecherche] = useState("");
  const [filtre, setFiltre] = useState<Filtre>("tous");

  const visibles = useMemo(() => {
    const terme = recherche.trim().toLocaleLowerCase("fr");
    return sites.filter((site) => {
      const correspondCategorie = filtre === "tous" || site.categorie === filtre;
      const correspondRecherche =
        !terme ||
        site.nom.toLocaleLowerCase("fr").includes(terme) ||
        site.commune.toLocaleLowerCase("fr").includes(terme) ||
        site.pdl?.toLocaleLowerCase("fr").includes(terme);
      return correspondCategorie && correspondRecherche;
    });
  }, [filtre, recherche, sites]);

  return (
    <section className="overflow-hidden rounded-2xl border border-[var(--kn-border)] bg-[var(--kn-card)] shadow-sm">
      <div className="flex flex-col gap-3 border-b border-[var(--kn-border)] p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full lg:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--kn-text-muted)]" />
          <Input
            value={recherche}
            onChange={(event) => setRecherche(event.target.value)}
            placeholder="Rechercher un site ou une commune…"
            aria-label="Rechercher un site"
            className="h-9 bg-[var(--kn-page)] pl-9"
          />
        </div>
        <div className="flex flex-wrap gap-1 rounded-xl bg-[var(--kn-panel)] p-1">
          {filtres.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setFiltre(option.value)}
              aria-pressed={filtre === option.value}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                filtre === option.value
                  ? "bg-[var(--kn-card)] text-[var(--kn-text)] shadow-sm"
                  : "text-[var(--kn-text-muted)] hover:text-[var(--kn-text)]"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="divide-y divide-[var(--kn-border)]">
        {visibles.map((site) => {
          const eclairage = site.categorie === "eclairage_public";
          const Icon = eclairage ? Lightbulb : Building2;
          return (
            <article key={site.id} className="flex flex-col gap-3 px-4 py-4 transition-colors hover:bg-[var(--kn-panel)]/60 sm:flex-row sm:items-center">
              <div
                className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${
                  eclairage
                    ? "bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300"
                    : "bg-sky-50 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300"
                }`}
              >
                <Icon className="size-[18px]" strokeWidth={1.8} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-sm font-semibold text-[var(--kn-text)]">{site.nom}</h3>
                  <span className="rounded-full bg-[var(--kn-active)] px-2 py-0.5 text-[10px] font-medium text-[var(--kn-text-muted)]">
                    {eclairage ? "Éclairage public" : "Bâtiment"}
                  </span>
                  {site.communeArchivee && (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-400/10 dark:text-amber-300">
                      Commune archivée
                    </span>
                  )}
                </div>
                <p className="mt-1 flex items-center gap-1 text-xs text-[var(--kn-text-muted)]">
                  <MapPin className="size-3.5" />
                  {site.commune}
                </p>
              </div>
              <dl className="grid grid-cols-3 gap-x-5 text-xs sm:min-w-[310px]">
                <div>
                  <dt className="text-[10px] uppercase tracking-wide text-[var(--kn-text-muted)]">PDL</dt>
                  <dd className="mt-1 truncate font-medium text-[var(--kn-text)]">{site.pdl || "—"}</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-wide text-[var(--kn-text-muted)]">Puissance</dt>
                  <dd className="mt-1 font-medium text-[var(--kn-text)]">{site.kva != null ? `${site.kva} kVA` : "—"}</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-wide text-[var(--kn-text-muted)]">Intensité</dt>
                  <dd className="mt-1 font-medium text-[var(--kn-text)]">{site.ampere != null ? `${site.ampere} A` : "—"}</dd>
                </div>
              </dl>
            </article>
          );
        })}

        {visibles.length === 0 && (
          <div className="px-6 py-14 text-center">
            <MapPin className="mx-auto size-8 text-[var(--kn-text-muted)]" strokeWidth={1.5} />
            <p className="mt-3 text-sm font-medium text-[var(--kn-text)]">Aucun site ne correspond</p>
            <p className="mt-1 text-xs text-[var(--kn-text-muted)]">
              Modifiez votre recherche ou le filtre de catégorie.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
