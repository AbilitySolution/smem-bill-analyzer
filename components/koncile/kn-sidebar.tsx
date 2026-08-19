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
  UploadCloud,
  Settings,
  LogOut,
} from "lucide-react";
import { logout } from "@/app/login/actions";
import { hasAtLeast } from "@/lib/authz";
import type { UserRole } from "@/lib/types/database";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

export interface SidebarUser {
  email: string | null;
  roleLabel: string;
}

/** `minRole` reflète la matrice de lib/authz.ts. Le masquage n'est qu'un confort : la
 *  page et le middleware refusent de leur côté, une entrée oubliée ici n'ouvre rien. */
type NavChild = {
  href: string;
  label: string;
  match: (pathname: string) => boolean;
  minRole?: UserRole;
};
type NavItem = {
  href: string;
  label: string;
  icon: typeof FileText;
  soon?: boolean;
  children?: NavChild[];
  /** Racine de la section, quand `href` pointe vers un sous-item (ex. /analyses vs /analyses/consommation). */
  section?: string;
  minRole?: UserRole;
};

const mainNav: NavItem[] = [
  {
    href: "/documents", label: "Documents", icon: FileText,
    children: [
      { href: "/upload", label: "Importer des documents", match: (p) => p.startsWith("/upload") },
      { href: "/documents", label: "Mes documents", match: (p) => p === "/documents" },
      { href: "/corrections", label: "Contrôle qualité", match: (p) => p.startsWith("/corrections"), minRole: "org_supervisor" },
      { href: "/qualite-extraction", label: "Qualité d'extraction", match: (p) => p.startsWith("/qualite-extraction"), minRole: "org_supervisor" },
      { href: "/documents/extraction", label: "Extraction", match: (p) => p.startsWith("/documents/extraction"), minRole: "org_supervisor" },
    ],
  },
  { href: "/rapport-excel", label: "Rapports", icon: FileSpreadsheet },
  {
    href: "/analyses/consommation", label: "Analyse", icon: Gauge, section: "/analyses",
    children: [
      { href: "/analyses/consommation", label: "Consommation", match: (p) => p === "/analyses/consommation" },
      { href: "/analyses/couverture", label: "Couverture", match: (p) => p === "/analyses/couverture" },
    ],
  },
  { href: "/anomalies", label: "Anomalies", icon: AlertTriangle },
  { href: "/connecteurs", label: "Connecteurs", icon: Plug, soon: true, minRole: "org_admin" },
];

const adminNav: NavItem[] = [
  { href: "/documentation", label: "Documentation", icon: BookOpen, minRole: "org_supervisor" },
  { href: "/parametres", label: "Paramètres", icon: Settings, minRole: "org_admin" },
];

/**
 * Applique la matrice à une liste d'entrées. Un parent dont tous les enfants sont filtrés
 * disparaît : il pointe vers la racine d'une section devenue vide, l'afficher promettrait
 * un contenu que la page refusera.
 */
function filtrerNav(items: NavItem[], role: UserRole): NavItem[] {
  return items.flatMap((item) => {
    if (item.minRole && !hasAtLeast(role, item.minRole)) return [];
    if (!item.children) return [item];
    const children = item.children.filter((c) => !c.minRole || hasAtLeast(role, c.minRole));
    return children.length === 0 ? [] : [{ ...item, children }];
  });
}

export function AbilitySidebar({
  user,
  role,
  isPlatformOperator = false,
}: {
  user: SidebarUser;
  role: UserRole;
  /** Membre de l'org Ability (opérateur de la plateforme) — voir lib/auth-platform.ts.
   *  Périmètre orthogonal aux rôles d'organisation : un opérateur n'est pas un admin
   *  client, et réciproquement. */
  isPlatformOperator?: boolean;
}) {
  const pathname = usePathname();
  const navPrincipale = filtrerNav(mainNav, role);
  const navAdmin = filtrerNav(adminNav, role);
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
        {navPrincipale.map((item) => {
          const anyChildActive = item.children?.some((c) => c.match(pathname)) ?? false;
          // Une entrée à sous-menu englobe toute sa section (ex. /analyses couvre aussi la
          // redirection legacy /analyses, dont le href pointe sur /analyses/consommation).
          const active = item.children
            ? isActive(item.section ?? item.href) || anyChildActive
            : isActive(item.href);
          return (
            <div key={item.label}>
              <Link
                href={item.href}
                className={cx(
                  "relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors",
                  active && !item.children
                    ? "bg-[var(--kn-yellow-soft)] font-semibold text-[var(--kn-text)]"
                    : active
                    ? "font-semibold text-[var(--kn-text)]"
                    : "text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]",
                )}
              >
                {active && !item.children && <span className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-[#f97316]" />}
                <item.icon className={cx("size-[17px] shrink-0", active && "text-[#ea580c]")} strokeWidth={1.75} />
                <span className="truncate">{item.label}</span>
                {item.soon && (
                  <span className="ml-auto shrink-0 rounded-full bg-[var(--kn-yellow-soft)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[#9a3412]">
                    Version bêta
                  </span>
                )}
              </Link>

              {item.children && (
                <div className="mb-0.5 ml-[26px] mt-0.5 flex flex-col gap-0.5 border-l border-[var(--kn-border)] pl-2">
                  {item.children.map((child) => {
                    const cActive = child.match(pathname);
                    return (
                      <Link
                        key={child.label}
                        href={child.href}
                        className={cx(
                          "relative rounded-md px-2.5 py-1.5 text-[12.5px] transition-colors",
                          cActive
                            ? "bg-[var(--kn-yellow-soft)] font-semibold text-[var(--kn-text)]"
                            : "text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]",
                        )}
                      >
                        {cActive && <span className="absolute -left-[9px] top-1/2 h-4 w-1 -translate-y-1/2 rounded-r-full bg-[#f97316]" />}
                        {child.label}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {navAdmin.length > 0 && (
          <>
            {/* Le superviseur n'y voit que la Documentation : lui annoncer « Administration »
                lui promettrait des droits qu'il n'a pas. */}
            <p className="px-2.5 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">
              {hasAtLeast(role, "org_admin") ? "Administration" : "Pilotage"}
            </p>
            {navAdmin.map((item) => {
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

        {/* Section opérateur : réservée aux membres de l'org Ability, visuellement
            distincte du bloc « Administration » client pour ne jamais confondre les
            deux contextes. La page elle-même re-vérifie le gate (notFound sinon). */}
        {isPlatformOperator && (
          <>
            <p className="px-2.5 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wide text-[#b45309]">
              Exploitation plateforme
            </p>
            <Link
              href="/exploitation"
              className={cx(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors",
                isActive("/exploitation")
                  ? "bg-[var(--kn-active)] font-medium text-[var(--kn-text)]"
                  : "text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]",
              )}
            >
              <Gauge className="size-[17px] shrink-0" strokeWidth={1.75} />
              <span className="truncate">Santé de la file</span>
            </Link>
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
