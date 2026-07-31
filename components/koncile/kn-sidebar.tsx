"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FileText,
  FileSpreadsheet,
  Gauge,
  AlertTriangle,
  Plug,
  BookOpen,
  Target,
  UploadCloud,
  Settings,
  LogOut,
} from "lucide-react";
import { logout } from "@/app/login/actions";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

export interface SidebarUser {
  email: string | null;
  roleLabel: string;
}

type NavItem = { href: string; label: string; icon: typeof FileText; soon?: boolean };

const mainNav: NavItem[] = [
  { href: "/documents", label: "Mes documents", icon: FileText },
  { href: "/rapport-excel", label: "Rapports", icon: FileSpreadsheet },
  { href: "/analyses", label: "Analyse de consommation", icon: Gauge },
  { href: "/anomalies", label: "Anomalies", icon: AlertTriangle, soon: true },
  { href: "/qualite-extraction", label: "Qualité d'extraction", icon: Target },
  { href: "/connecteurs", label: "Connecteurs", icon: Plug, soon: true },
];

const adminNav: NavItem[] = [
  { href: "/documentation", label: "Documentation", icon: BookOpen },
  { href: "/parametres", label: "Paramètres", icon: Settings },
];

export function AbilitySidebar({
  user,
  isAdmin = false,
}: {
  user: SidebarUser;
  isAdmin?: boolean;
}) {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");
  const initials = (user.email ?? "?").slice(0, 2).toUpperCase();

  return (
    <aside className="flex h-full w-[230px] shrink-0 flex-col border-r border-[var(--kn-border)] bg-[var(--kn-card)]">
      {/* Logo Ability (marque A seule) */}
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
        <Image src="/ability-mark.png" alt="Ability" width={120} height={108} className="h-8 w-auto object-contain" priority />
        <div className="leading-tight">
          <p className="font-heading text-[15px] font-bold tracking-tight text-[var(--kn-text)]">ABILITY</p>
          <p className="text-[11px] text-[var(--kn-text-muted)]">Documents</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2.5 pt-1">
        <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">
          Extraction
        </p>
        {mainNav.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cx(
                "relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors",
                active
                  ? "bg-[var(--kn-yellow-soft)] font-semibold text-[var(--kn-text)]"
                  : "text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]",
              )}
            >
              {active && <span className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-[#f97316]" />}
              <item.icon className={cx("size-[17px] shrink-0", active && "text-[#ea580c]")} strokeWidth={1.75} />
              <span className="truncate">{item.label}</span>
              {item.soon && (
                <span className="ml-auto shrink-0 rounded-full bg-[var(--kn-yellow-soft)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[#9a3412]">
                  Version bêta
                </span>
              )}
            </Link>
          );
        })}

        {isAdmin && (
          <>
            <p className="px-2.5 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">
              Administration
            </p>
            {adminNav.map((item) => {
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cx(
                    "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors",
                    active
                      ? "bg-[var(--kn-active)] font-medium text-[var(--kn-text)]"
                      : "text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]",
                  )}
                >
                  <item.icon className="size-[17px] shrink-0" strokeWidth={1.75} />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </>
        )}
      </nav>

      {/* Bouton Importer */}
      <div className="px-3 pb-2">
        <Link
          href="/upload"
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--kn-solid)] py-2.5 text-[13px] font-medium text-white transition-colors hover:opacity-90"
        >
          <UploadCloud className="size-4" strokeWidth={2} />
          Importer mes documents
        </Link>
      </div>

      {/* Profil utilisateur (réel) */}
      <div className="border-t border-[var(--kn-border)] p-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--kn-solid)] text-[11px] font-medium text-white">
            {initials}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[12px] font-medium text-[var(--kn-text)]">{user.email ?? "—"}</p>
            <p className="truncate text-[11px] text-[var(--kn-text-muted)]">{user.roleLabel}</p>
          </div>
          <form action={logout}>
            <button
              type="submit"
              aria-label="Déconnexion"
              className="rounded-md p-1.5 text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]"
            >
              <LogOut className="size-4" strokeWidth={1.75} />
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
