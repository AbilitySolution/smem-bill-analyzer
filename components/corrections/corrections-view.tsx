"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, ChevronRight, Loader2 } from "lucide-react";
import type { CorrectionItem } from "@/lib/data/corrections";
import { dismissCorrections } from "@/app/(app)/corrections/actions";

const euro = (value: number | null) =>
  value === null ? "—" : `${value.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/**
 * Écran de rattrapage des factures enregistrées automatiquement mais peu sûres.
 *
 * Deux sorties, comme demandé : corriger une facture à la fois (chaque ligne ouvre
 * l'éditeur existant), ou tout accepter en bloc pour y revenir plus tard. Pas de
 * troisième chemin — un écran de correction qui propose trop d'options ne se traite
 * jamais.
 */
export function CorrectionsView({ items }: { items: CorrectionItem[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function dismissAll() {
    if (!window.confirm(
      `Accepter les ${items.length} factures telles qu'elles ont été lues ? Elles sortiront de cette liste et resteront modifiables depuis Mes documents.`,
    )) return;
    setError(null);
    startTransition(async () => {
      const result = await dismissCorrections(items.map((item) => item.id));
      if (!result.ok) setError(result.error ?? "Action impossible.");
      else router.refresh();
    });
  }

  if (!items.length) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10">
        <h1 className="font-heading text-2xl font-bold text-[var(--kn-text)]">Contrôle qualité</h1>
        <div className="mt-6 flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--kn-border)] px-6 py-14 text-center">
          <CheckCircle2 className="size-9 text-emerald-500" strokeWidth={1.5} />
          <p className="text-sm font-medium text-[var(--kn-text)]">Rien à vérifier</p>
          <p className="max-w-sm text-[13px] text-[var(--kn-text-muted)]">
            Toutes les factures importées ont été lues avec un niveau de confiance suffisant.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-[var(--kn-text)]">
            Contrôle qualité
            <span className="ml-2 text-lg font-normal text-[var(--kn-text-muted)]">
              {items.length} facture{items.length > 1 ? "s" : ""}
            </span>
          </h1>
          <p className="mt-1 max-w-xl text-[13px] text-[var(--kn-text-muted)]">
            Elles sont déjà enregistrées et comptées dans vos analyses. Leur lecture a été
            jugée incertaine — un contrôle rapide évite qu&apos;une erreur passe inaperçue.
            Rien ne presse : vous pouvez quitter cette page et y revenir, elles resteront ici.
          </p>
        </div>
        {/* Les trois sorties, dans l'ordre d'engagement croissant : partir sans rien
            faire (le lien de gauche suffit — aucune action n'est imposée), tout
            accepter, ou corriger en série. */}
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={dismissAll}
            disabled={pending}
            className="flex cursor-pointer items-center gap-2 rounded-xl border border-[var(--kn-border)] px-4 py-2.5 text-[13px] font-medium text-[var(--kn-text)] transition-colors hover:bg-[var(--kn-active)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
            Tout accepter
          </button>
          <Link
            href={`/documents/extraction?id=${items[0].id}&review=1`}
            className="flex items-center gap-2 rounded-xl bg-[#f97316] px-4 py-2.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
          >
            Corriger une par une <ChevronRight className="size-4" />
          </Link>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertTriangle className="size-4 shrink-0" /> {error}
        </div>
      )}

      <div className="space-y-2">
        {items.map((item) => (
          <Link
            key={item.id}
            href={`/documents/extraction?id=${item.id}`}
            className="flex items-center gap-3 rounded-xl border border-amber-300 bg-[var(--kn-card)] px-4 py-3 transition-colors hover:border-[#f97316]"
          >
            <AlertTriangle className="size-5 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-[var(--kn-text)]">
                {item.facture_number || "Numéro non lu"}
                <span className="ml-2 font-normal text-[var(--kn-text-muted)]">
                  {item.site_nom ?? item.commune_nom ?? "site non rattaché"}
                </span>
              </p>
              <p className="mt-0.5 text-xs text-[var(--kn-text-muted)]">
                {item.facture_date ?? "date inconnue"} · {euro(item.total_ttc)} · {item.reasons.join(" · ")}
              </p>
            </div>
            <span className="hidden shrink-0 text-xs font-semibold text-[#f97316] sm:inline">Vérifier</span>
            <ChevronRight className="size-4 shrink-0 text-[var(--kn-text-muted)]" />
          </Link>
        ))}
      </div>
    </div>
  );
}
