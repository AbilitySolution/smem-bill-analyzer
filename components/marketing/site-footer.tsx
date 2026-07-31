import Image from "next/image";
import Link from "next/link";

const LINKS = [
  { href: "#fonctionnalites", label: "Fonctionnalités" },
  { href: "#comment-ca-marche", label: "Comment ça marche" },
  { href: "/login", label: "Accéder à mon espace" },
];

export function SiteFooter() {
  return (
    <footer id="contact" className="border-t border-[var(--kn-border)] bg-[var(--kn-panel)]">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-12 md:flex-row md:items-start md:justify-between">
        <div className="max-w-sm">
          <div className="flex items-center gap-2.5">
            <Image src="/ability-mark.png" alt="" width={120} height={108} className="h-7 w-auto object-contain" />
            <span className="font-heading text-[15px] font-bold tracking-tight text-[var(--kn-text)]">ABILITY SOLUTIONS</span>
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-[var(--kn-text-muted)]">
            Gestion documentaire et extraction intelligente des factures d&apos;énergie .Centralisez, vérifiez et analysez la consommation de vos sites.
          </p>
        </div>

        <div className="flex gap-16">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">Produit</p>
            <ul className="mt-3 flex flex-col gap-2">
              {LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-[13px] text-[var(--kn-text-muted)] transition-colors hover:text-[var(--kn-text)]">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">Contact</p>
            <ul className="mt-3 flex flex-col gap-2">
              <li>
                <a href="mailto:contact@ability.app" className="text-[13px] text-[var(--kn-text-muted)] transition-colors hover:text-[var(--kn-text)]">
                  contact@ability.app
                </a>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <div className="border-t border-[var(--kn-border)] px-6 py-5">
        <p className="mx-auto max-w-6xl text-[12px] text-[var(--kn-text-muted)]">
          © {new Date().getFullYear()} Ability Solutions. Tous droits réservés.
        </p>
      </div>
    </footer>
  );
}
