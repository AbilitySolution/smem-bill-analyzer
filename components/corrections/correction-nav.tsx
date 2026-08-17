"use client";

import Link from "next/link";
import { ArrowLeft, ChevronLeft, ChevronRight, CheckCircle2 } from "lucide-react";
import type { CorrectionItem } from "@/lib/data/corrections";

/**
 * Barre de navigation du mode « corriger une par une ».
 *
 * Remplace le sélecteur habituel de la page d'extraction, qui liste TOUTES les factures
 * de l'organisation (290 chez le client de référence) — inutilisable pour enchaîner une
 * poignée de corrections ciblées. Ici l'utilisateur ne voit que la file de contrôle
 * qualité, sa position dedans, et de quoi passer à la suivante sans repasser par la
 * liste.
 *
 * L'éditeur lui-même (le composant `Detail` de la page) reste inchangé : c'est le même
 * formulaire que partout ailleurs, seule la barre de pilotage diffère.
 */
export function CorrectionNav({
  items,
  currentId,
}: {
  items: CorrectionItem[];
  currentId: string;
}) {
  const index = items.findIndex((item) => item.id === currentId);
  const current = index >= 0 ? items[index] : null;
  const previous = index > 0 ? items[index - 1] : null;
  const next = index >= 0 && index < items.length - 1 ? items[index + 1] : null;

  // Facture corrigée puis sortie de la liste : on ramène vers la file plutôt que
  // d'afficher une position fantôme (« document 0 sur 12 »).
  if (!current) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2.5">
        <span className="flex items-center gap-2 text-[13px] font-medium text-emerald-900">
          <CheckCircle2 className="size-4 shrink-0" />
          Cette facture ne fait plus partie du contrôle qualité.
        </span>
        <Link
          href="/corrections"
          className="shrink-0 rounded-lg bg-[#f97316] px-3.5 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
        >
          {items.length > 0 ? `Continuer (${items.length} restante${items.length > 1 ? "s" : ""})` : "Retour"}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5">
      <Link
        href="/corrections"
        className="flex shrink-0 items-center gap-1.5 text-[13px] font-medium text-amber-900 transition-opacity hover:opacity-70"
      >
        <ArrowLeft className="size-4" /> Contrôle qualité
      </Link>

      <div className="min-w-0 flex-1 text-center">
        <p className="truncate text-[13px] font-semibold text-amber-900">
          Facture {index + 1} <span className="font-normal">sur {items.length}</span>
          {current.facture_number && <span className="ml-2 font-normal">· {current.facture_number}</span>}
        </p>
        <p className="truncate text-[11px] text-amber-800">{current.reasons.join(" · ")}</p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {previous ? (
          <Link
            href={`/documents/extraction?id=${previous.id}&review=1`}
            aria-label="Facture précédente"
            className="rounded-lg border border-amber-300 bg-white p-1.5 text-amber-900 transition-colors hover:bg-amber-100"
          >
            <ChevronLeft className="size-4" />
          </Link>
        ) : (
          <span className="rounded-lg border border-amber-200 p-1.5 text-amber-300"><ChevronLeft className="size-4" /></span>
        )}
        {next ? (
          <Link
            href={`/documents/extraction?id=${next.id}&review=1`}
            aria-label="Facture suivante"
            className="flex items-center gap-1 rounded-lg bg-[#f97316] px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
          >
            Suivante <ChevronRight className="size-4" />
          </Link>
        ) : (
          <Link
            href="/corrections"
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
          >
            Terminer
          </Link>
        )}
      </div>
    </div>
  );
}
