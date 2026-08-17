import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * Pagination server-rendered, pilotée par l'URL.
 *
 * Chaque page est une vraie adresse (`?page=3`) plutôt qu'un état de composant : le
 * bouton Retour du navigateur fonctionne, un lien se partage, et un rechargement
 * retombe au même endroit. C'est aussi ce qui permet de rester en composant serveur —
 * aucun JavaScript n'est nécessaire pour naviguer.
 *
 * Réservée aux listes NON virtualisées. Sur une liste virtualisée, la pagination
 * ajoute une contrainte (retenir sa page) pour résoudre un problème de volume que la
 * virtualisation a déjà réglé.
 */

export function Pagination({
  currentPage,
  totalPages,
  totalItems,
  basePath,
  itemLabel = "élément",
}: {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  /** Chemin de base, sans paramètre de page (ex. `/corrections`). */
  basePath: string;
  /** Nom au singulier de ce qui est listé, pour le résumé (« 13 factures »). */
  itemLabel?: string;
}) {
  if (totalPages <= 1) return null;

  const pageHref = (page: number) => (page <= 1 ? basePath : `${basePath}?page=${page}`);

  // Fenêtre glissante autour de la page courante : au-delà d'une dizaine de pages,
  // afficher tous les numéros déborde et n'aide personne à se repérer.
  const windowSize = 2;
  const pages: Array<number | "gap"> = [];
  for (let page = 1; page <= totalPages; page++) {
    const inWindow = Math.abs(page - currentPage) <= windowSize;
    if (page === 1 || page === totalPages || inWindow) {
      pages.push(page);
    } else if (pages[pages.length - 1] !== "gap") {
      pages.push("gap");
    }
  }

  return (
    <nav
      aria-label="Pagination"
      className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--kn-border)] pt-4"
    >
      <p className="text-[13px] text-[var(--kn-text-muted)]">
        Page <span className="font-semibold text-[var(--kn-text)]">{currentPage}</span> sur {totalPages}
        <span className="mx-1.5">·</span>
        {totalItems.toLocaleString("fr-FR")} {itemLabel}{totalItems > 1 ? "s" : ""} au total
      </p>

      <div className="flex items-center gap-1">
        {currentPage > 1 ? (
          <Link
            href={pageHref(currentPage - 1)}
            rel="prev"
            aria-label="Page précédente"
            className="flex size-9 items-center justify-center rounded-lg border border-[var(--kn-border)] text-[var(--kn-text)] transition-colors hover:bg-[var(--kn-active)]"
          >
            <ChevronLeft className="size-4" />
          </Link>
        ) : (
          <span
            aria-hidden
            className="flex size-9 items-center justify-center rounded-lg border border-[var(--kn-border)] text-[var(--kn-text-muted)] opacity-40"
          >
            <ChevronLeft className="size-4" />
          </span>
        )}

        {pages.map((page, index) =>
          page === "gap" ? (
            <span key={`gap-${index}`} aria-hidden className="px-1 text-[var(--kn-text-muted)]">…</span>
          ) : page === currentPage ? (
            // `aria-current` annonce la page active aux lecteurs d'écran ; la couleur
            // seule ne suffirait pas à la signaler.
            <span
              key={page}
              aria-current="page"
              className="flex size-9 items-center justify-center rounded-lg bg-[#f97316] text-[13px] font-semibold text-white"
            >
              {page}
            </span>
          ) : (
            <Link
              key={page}
              href={pageHref(page)}
              aria-label={`Page ${page}`}
              className="flex size-9 items-center justify-center rounded-lg border border-[var(--kn-border)] text-[13px] text-[var(--kn-text)] transition-colors hover:bg-[var(--kn-active)]"
            >
              {page}
            </Link>
          ),
        )}

        {currentPage < totalPages ? (
          <Link
            href={pageHref(currentPage + 1)}
            rel="next"
            aria-label="Page suivante"
            className="flex size-9 items-center justify-center rounded-lg border border-[var(--kn-border)] text-[var(--kn-text)] transition-colors hover:bg-[var(--kn-active)]"
          >
            <ChevronRight className="size-4" />
          </Link>
        ) : (
          <span
            aria-hidden
            className="flex size-9 items-center justify-center rounded-lg border border-[var(--kn-border)] text-[var(--kn-text-muted)] opacity-40"
          >
            <ChevronRight className="size-4" />
          </span>
        )}
      </div>
    </nav>
  );
}
