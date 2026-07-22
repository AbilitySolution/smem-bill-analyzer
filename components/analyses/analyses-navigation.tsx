"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/analyses/consommation", label: "Consommation" },
  { href: "/analyses/couverture", label: "Couverture" },
] as const;

export function AnalysesNavigation() {
  const pathname = usePathname();

  return (
    <nav aria-label="Vues d'analyse" className="border-b border-[var(--kn-border)] px-8">
      <div className="mx-auto flex max-w-6xl gap-1">
        {TABS.map((tab) => {
          const active = pathname === tab.href;

          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`relative px-4 py-3 text-[14px] font-medium transition-colors ${
                active
                  ? "text-[var(--kn-text)]"
                  : "text-[var(--kn-text-muted)] hover:text-[var(--kn-text)]"
              }`}
            >
              {tab.label}
              {active && <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-[#f97316]" />}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
