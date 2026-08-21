"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Building2,
  ChevronRight,
  Inbox,
  Landmark,
  MapPinned,
  UserRound,
  UsersRound,
} from "lucide-react";

const sections = [
  {
    label: "Organisation",
    items: [
      {
        href: "/parametres/communes",
        label: "Communes",
        description: "Périmètres et données métier",
        icon: Landmark,
      },
      {
        href: "/parametres/sites",
        label: "Sites",
        description: "Bâtiments et éclairage public",
        icon: MapPinned,
      },
      {
        href: "/parametres/demandes",
        label: "Liens de dépôt",
        description: "Collecte externe de fichiers",
        icon: Inbox,
      },
    ],
  },
  {
    label: "Utilisateurs",
    items: [
      {
        href: "/parametres/utilisateurs",
        label: "Accès et rôles",
        description: "Invitations et autorisations",
        icon: UsersRound,
      },
      {
        href: "/parametres/profil",
        label: "Profil utilisateur",
        description: "Nom et photo de profil",
        icon: UserRound,
      },
    ],
  },
] as const;

function NavItems({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();

  if (mobile) {
    return (
      <div className="flex min-w-max gap-1 px-4 pb-3">
        {sections.flatMap((section) =>
          section.items.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? "bg-[var(--kn-yellow-soft)] text-[var(--kn-text)]"
                    : "text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]"
                }`}
              >
                <item.icon className={`size-4 ${active ? "text-[#ea580c]" : ""}`} />
                {item.label}
              </Link>
            );
          }),
        )}
      </div>
    );
  }

  return sections.map((section) => (
    <div key={section.label} className="space-y-1">
      <p className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--kn-text-muted)]">
        {section.label}
      </p>
      {section.items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`group relative flex items-start gap-2.5 rounded-xl px-3 py-2.5 transition-colors ${
              active
                ? "bg-[var(--kn-yellow-soft)] text-[var(--kn-text)]"
                : "text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]"
            }`}
          >
            {active && (
              <span className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-[#f97316]" />
            )}
            <item.icon
              className={`mt-0.5 size-4 shrink-0 ${active ? "text-[#ea580c]" : ""}`}
              strokeWidth={1.8}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold leading-5">{item.label}</span>
              <span className="block text-[11px] leading-4 text-[var(--kn-text-muted)]">
                {item.description}
              </span>
            </span>
            <ChevronRight
              className={`mt-1 size-3.5 shrink-0 transition-opacity ${
                active ? "text-[#ea580c]" : "opacity-0 group-hover:opacity-70"
              }`}
            />
          </Link>
        );
      })}
    </div>
  ));
}

export function SettingsNav() {
  return (
    <>
      <aside className="sticky top-0 hidden h-[calc(100vh-3rem)] w-[244px] shrink-0 self-start border-r border-[var(--kn-border)] bg-[var(--kn-panel)]/70 md:flex md:flex-col">
        <div className="border-b border-[var(--kn-border)] px-5 py-5">
          <div className="mb-3 flex size-9 items-center justify-center rounded-xl bg-[var(--kn-yellow-soft)] text-[#ea580c]">
            <Building2 className="size-[18px]" strokeWidth={1.8} />
          </div>
          <h1 className="font-heading text-lg font-semibold text-[var(--kn-text)]">Paramètres</h1>
          <p className="mt-1 text-xs leading-5 text-[var(--kn-text-muted)]">
            Administration de votre espace Ability.
          </p>
        </div>
        <nav className="flex-1 space-y-3 overflow-y-auto p-3" aria-label="Rubriques des paramètres">
          <NavItems />
        </nav>
      </aside>

      <div className="sticky top-0 z-20 w-full shrink-0 border-b border-[var(--kn-border)] bg-[var(--kn-card)]/95 pt-3 backdrop-blur md:hidden">
        <div className="flex items-center gap-2 px-4 pb-3">
          <div className="flex size-8 items-center justify-center rounded-lg bg-[var(--kn-yellow-soft)] text-[#ea580c]">
            <Building2 className="size-4" />
          </div>
          <div>
            <p className="font-heading text-sm font-semibold text-[var(--kn-text)]">Paramètres</p>
            <p className="text-[11px] text-[var(--kn-text-muted)]">Administration de l’espace</p>
          </div>
        </div>
        <nav className="overflow-x-auto" aria-label="Rubriques des paramètres">
          <NavItems mobile />
        </nav>
      </div>
    </>
  );
}
