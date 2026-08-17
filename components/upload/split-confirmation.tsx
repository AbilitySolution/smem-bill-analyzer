"use client";

import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, FileText, Loader2, ScanLine, UploadCloud, X } from "lucide-react";
import { looksOverSplit, type DetectedInvoice } from "@/lib/anthropic/invoice-splitting";
import { renderPagePreviews } from "@/lib/documents/pdf-split";

/**
 * Écran de confirmation du découpage d'un scan multi-factures.
 *
 * Point d'arrêt volontaire du flux : rien n'est mis en file tant que l'utilisateur n'a
 * pas vu ce qui a été détecté. Le découpage automatique sans validation est exactement
 * ce qui a produit 14 factures fausses en production — un document de 58 pages y était
 * passé pour une facture unique portant le total de tout le lot.
 *
 * L'utilisateur peut décocher une facture détectée à tort (une page de garde prise pour
 * une facture, par exemple) avant de confirmer.
 */

export interface SplitCandidate {
  file: File;
  pageCount: number;
  invoices: DetectedInvoice[];
}

export function SplitConfirmation({
  candidate,
  onConfirm,
  onCancel,
  submitting,
}: {
  candidate: SplitCandidate;
  onConfirm: (accepted: DetectedInvoice[]) => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const [previews, setPreviews] = useState<Array<string | null> | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());

  // Vignettes de la première page de chaque facture : c'est ce qui permet de vérifier
  // le découpage d'un coup d'œil plutôt que d'ouvrir chaque fichier.
  //
  // Pas de remise à zéro de `previews` ici : l'appelant monte ce composant avec une
  // `key` liée au document, donc un nouveau candidat repart d'un état vierge — le
  // mécanisme React prévu pour ça, et le seul qui évite d'afficher un instant les
  // vignettes du document précédent.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rendered = await renderPagePreviews(
        candidate.file,
        candidate.invoices.map((invoice) => invoice.start_page),
      ).catch(() => null);
      if (!cancelled) setPreviews(rendered);
    })();
    return () => { cancelled = true; };
  }, [candidate]);

  const accepted = candidate.invoices.filter((_, index) => !excluded.has(index));

  return (
    <div className="mt-4 rounded-xl border-2 border-[#f97316] bg-[var(--kn-card)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <ScanLine className="mt-0.5 size-5 shrink-0 text-[#f97316]" />
          <div>
            <p className="text-sm font-semibold text-[var(--kn-text)]">
              {candidate.invoices.length} facture{candidate.invoices.length > 1 ? "s" : ""} détectée{candidate.invoices.length > 1 ? "s" : ""} dans ce document
            </p>
            <p className="mt-0.5 text-xs text-[var(--kn-text-muted)]">
              {candidate.file.name} · {candidate.pageCount} pages · sera découpé en {accepted.length} fichier{accepted.length > 1 ? "s" : ""} avant traitement
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          aria-label="Annuler le découpage"
          className="cursor-pointer rounded-lg p-1 text-[var(--kn-text-muted)] transition-colors hover:text-[var(--kn-text)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {candidate.invoices.map((invoice, index) => {
          const isExcluded = excluded.has(index);
          const preview = previews?.[index] ?? null;
          return (
            <button
              key={`${invoice.start_page}-${invoice.end_page}`}
              type="button"
              disabled={submitting}
              aria-pressed={!isExcluded}
              onClick={() => setExcluded((current) => {
                const next = new Set(current);
                if (next.has(index)) next.delete(index);
                else next.add(index);
                return next;
              })}
              className={`group relative overflow-hidden rounded-lg border-2 text-left transition-colors disabled:cursor-not-allowed ${
                isExcluded
                  ? "border-[var(--kn-border)] opacity-45"
                  : "cursor-pointer border-emerald-400 hover:border-[#f97316]"
              }`}
            >
              <div className="relative h-28 bg-white">
                {previews === null ? (
                  <div className="flex h-full items-center justify-center">
                    <Loader2 className="size-4 animate-spin text-[var(--kn-text-muted)]" />
                  </div>
                ) : preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={preview} alt={`Page ${invoice.start_page}`} className="h-full w-full object-cover object-top" />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <FileText className="size-8 text-[#f97316]" strokeWidth={1.4} />
                  </div>
                )}
                <span className={`absolute right-1 top-1 rounded-full p-0.5 ${isExcluded ? "bg-[var(--kn-panel)] text-[var(--kn-text-muted)]" : "bg-emerald-500 text-white"}`}>
                  <CheckCircle2 className="size-3.5" />
                </span>
              </div>
              <div className="px-2 py-1.5">
                <p className="truncate text-[11px] font-semibold text-[var(--kn-text)]">
                  {invoice.facture_number ?? invoice.label ?? `Facture ${index + 1}`}
                </p>
                <p className="text-[11px] text-[var(--kn-text-muted)]">
                  {invoice.start_page === invoice.end_page
                    ? `page ${invoice.start_page}`
                    : `pages ${invoice.start_page}–${invoice.end_page}`}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      <p className="mt-2.5 text-xs text-[var(--kn-text-muted)]">
        Cliquez une vignette pour l&apos;exclure du découpage. Vérifiez que chaque vignette
        correspond bien au <span className="font-medium text-[var(--kn-text)]">début</span> d&apos;une facture.
      </p>

      {/* Découpage suspect : on prévient sans décider à la place de l'utilisateur —
          un lot de factures réellement mono-page produirait le même profil. */}
      {looksOverSplit(candidate.invoices, candidate.pageCount) && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-semibold">Découpage à vérifier de près.</span> Presque autant
            de factures que de pages ont été détectées. Une facture EDF fait souvent 2 pages ou
            plus : les vignettes qui montrent un tableau de consommation ou des mentions légales
            sont des suites de facture, pas des débuts — excluez-les.
          </span>
        </div>
      )}

      {accepted.length === 0 && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertCircle className="size-4 shrink-0" />
          Toutes les factures sont exclues — annulez, ou réactivez au moins une vignette.
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={submitting || accepted.length === 0}
          onClick={() => onConfirm(accepted)}
          className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg bg-[#f97316] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? <Loader2 className="size-4 animate-spin" /> : <UploadCloud className="size-4" />}
          {submitting
            ? "Découpage et envoi…"
            : `Importer ${accepted.length} facture${accepted.length > 1 ? "s" : ""}`}
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={onCancel}
          className="cursor-pointer rounded-lg border border-[var(--kn-border)] px-4 py-2.5 text-sm font-medium text-[var(--kn-text)] transition-colors hover:bg-[var(--kn-active)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Annuler
        </button>
      </div>
    </div>
  );
}
