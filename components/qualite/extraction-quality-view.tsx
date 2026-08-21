"use client";

import { useState } from "react";
import { Target, FileCheck2, Sparkles, Info, AlertTriangle, ArrowUpDown } from "lucide-react";
import type { ExtractionQuality, FieldQuality } from "@/lib/data/extraction-quality";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** Vert au-dessus de 95%, ambre entre 85 et 95, rouge en dessous. */
function toneOf(precision: number): { color: string; label: string } {
  if (precision >= 0.95) return { color: "#16a34a", label: "Fiable" };
  if (precision >= 0.85) return { color: "#d97706", label: "À surveiller" };
  return { color: "#dc2626", label: "À améliorer" };
}

type SortKey = "precision" | "volume";

export function ExtractionQualityView({ data }: { data: ExtractionQuality }) {
  const [sort, setSort] = useState<SortKey>("precision");

  const measured = data.fields.filter((f) => f.precision != null);
  const unmeasured = data.fields.filter((f) => f.precision == null);
  // Dénominateur des « champs notés » : tous ceux qui ont au moins une facture où le champ
  // avait une valeur à extraire. Afficher le seul `measured.length` laisserait croire qu'un
  // seul champ est suivi tant que l'échantillon est trop court.
  const trackedCount = measured.length + unmeasured.length;

  // Par défaut : les champs les moins fiables d'abord — c'est là qu'il y a à agir.
  const sorted = [...measured].sort((a, b) =>
    sort === "precision" ? a.precision! - b.precision! : b.extracted - a.extracted,
  );

  return (
    <div className="mx-auto max-w-5xl px-8 py-6">
      {/* Pas de titre ici : la page est un onglet de Documentation, dont l'en-tête porte
          déjà le titre. Seul reste ce que l'onglet ne dit pas — ce que le chiffre mesure. */}
      <p className="mb-5 max-w-3xl text-[13px] text-[var(--kn-text-muted)]">
        Précision réelle de l&apos;extraction automatique, mesurée sur les corrections que vos équipes
        ont effectivement apportées — pas une estimation du modèle sur lui-même. Seules les factures
        ouvertes et relues champ par champ comptent : accepter une facture sans la lire ne dit rien
        de la justesse de sa lecture.
      </p>

      {data.isDemo && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-[#fed7aa] bg-[var(--kn-yellow-soft)] px-3 py-2 text-[12px] text-[#9a3412]">
          <AlertTriangle className="size-4 shrink-0" />
          Données de démonstration — vos chiffres réels s&apos;affichent une fois connecté.
        </div>
      )}

      {/* Métrique phare */}
      <div className="mb-5 flex flex-col gap-4 rounded-xl border border-[#fed7aa] bg-gradient-to-br from-[var(--kn-yellow-soft)] to-transparent px-5 py-4 sm:flex-row sm:items-center">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-[#f97316] text-white">
          <Target className="size-6" />
        </span>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#9a3412]">
            Précision globale de l&apos;extraction
          </p>
          <p className="font-heading text-3xl font-bold tabular-nums text-[var(--kn-text)]">
            {data.overallPrecision != null ? pct(data.overallPrecision) : "—"}
          </p>
          <p className="text-[12px] text-[var(--kn-text-muted)]">
            Sur {data.invoiceCount} facture{data.invoiceCount > 1 ? "s" : ""} relue{data.invoiceCount > 1 ? "s" : ""} à la main
            {" — "}part des champs extraits qui n&apos;ont demandé aucune retouche.
          </p>
        </div>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kpi
          icon={<FileCheck2 className="size-4" />}
          label="Factures relues"
          value={String(data.invoiceCount)}
          hint="Ouvertes et enregistrées par un humain"
        />
        <Kpi
          icon={<Sparkles className="size-4" />}
          label="Relues sans retouche"
          value={`${data.untouchedCount} (${data.invoiceCount ? pct(data.untouchedCount / data.invoiceCount) : "—"})`}
          hint="L'IA avait tout lu correctement"
        />
        <Kpi
          icon={<Target className="size-4" />}
          label="Champs notés"
          value={`${measured.length} sur ${trackedCount}`}
          hint={`${data.minSample} factures relues minimum par champ`}
        />
      </div>

      {/* Détail par champ */}
      <div className="rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-heading text-[15px] font-semibold text-[var(--kn-text)]">Précision champ par champ</h2>
            <p className="text-[12px] text-[var(--kn-text-muted)]">
              Les champs les moins fiables en premier — ce sont eux qui coûtent du temps de relecture.
            </p>
          </div>
          <button
            onClick={() => setSort((s) => (s === "precision" ? "volume" : "precision"))}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--kn-border)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--kn-text-muted)] transition-colors hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]"
          >
            <ArrowUpDown className="size-3.5" />
            Trier par {sort === "precision" ? "volume" : "précision"}
          </button>
        </div>

        {sorted.length === 0 ? (
          <p className="mx-auto max-w-md py-10 text-center text-[13px] text-[var(--kn-text-muted)]">
            Pas encore assez de factures relues pour mesurer la précision. Chaque facture ouverte
            et enregistrée depuis Contrôle qualité ou Extraction alimente cette page.
          </p>
        ) : (
          <div className="flex flex-col">
            {sorted.map((f) => <FieldRow key={f.key} field={f} />)}
          </div>
        )}

        {unmeasured.length > 0 && (
          <p className="mt-3 border-t border-[var(--kn-border)] pt-3 text-[12px] text-[var(--kn-text-muted)]">
            {unmeasured.length} champ{unmeasured.length > 1 ? "s" : ""} en attente de mesure —
            moins de 5 factures validées les contiennent, un taux ne serait pas significatif.
          </p>
        )}
      </div>

      {/* Méthode — la transparence est ce qui rend le chiffre crédible */}
      <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-panel)] px-4 py-3">
        <Info className="mt-0.5 size-4 shrink-0 text-[var(--kn-text-muted)]" />
        <div className="text-[12px] leading-relaxed text-[var(--kn-text-muted)]">
          <p className="mb-1 font-medium text-[var(--kn-text)]">Comment ce chiffre est calculé</p>
          Chaque correction manuelle est journalisée (champ, valeur avant/après, auteur, date), qu&apos;elle
          survienne à la revue initiale ou lors d&apos;une reprise ultérieure. Pour un champ donné, la précision
          est la part des factures validées où ce champ n&apos;a{" "}<em>pas</em>{" "}eu besoin d&apos;être corrigé.
          Seules les factures relues par un humain sont comptées : tant que personne n&apos;a vérifié une facture,
          on ne peut pas affirmer que l&apos;extraction était juste.
          {data.otherCorrections > 0 && (
            <> {data.otherCorrections} correction{data.otherCorrections > 1 ? "s" : ""} portent sur des champs
            secondaires non suivis ici et ne sont pas comptabilisées.</>
          )}
        </div>
      </div>
    </div>
  );
}

function FieldRow({ field }: { field: FieldQuality }) {
  const tone = toneOf(field.precision!);
  return (
    <div className="flex items-center gap-3 border-b border-[var(--kn-border)] py-2.5 last:border-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-[var(--kn-text)]">{field.label}</p>
        <p className="text-[11px] text-[var(--kn-text-muted)]">
          {field.corrected} correction{field.corrected > 1 ? "s" : ""} sur {field.extracted} facture
          {field.extracted > 1 ? "s" : ""}
        </p>
      </div>

      <div className="hidden h-1.5 w-40 shrink-0 overflow-hidden rounded-full bg-[var(--kn-value-box)] sm:block">
        <div
          className="h-full rounded-full transition-[width]"
          style={{ width: `${Math.max(2, field.precision! * 100)}%`, background: tone.color }}
        />
      </div>

      <span className="w-16 shrink-0 text-right text-[13px] font-semibold tabular-nums" style={{ color: tone.color }}>
        {pct(field.precision!)}
      </span>
      <span
        className={cx("hidden w-24 shrink-0 rounded-full px-2 py-0.5 text-center text-[11px] font-medium md:block")}
        style={{ color: tone.color, background: `${tone.color}1f` }}
      >
        {tone.label}
      </span>
    </div>
  );
}

function Kpi({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--kn-yellow-soft)] text-[#ea580c]">{icon}</span>
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--kn-text-muted)]">{label}</p>
        <p className="truncate text-[16px] font-bold tabular-nums text-[var(--kn-text)]">{value}</p>
        {/* Un chiffre encore à zéro doit expliquer ce qui le débloque, sinon il se lit
            comme une panne plutôt que comme un compteur qui démarre. */}
        {hint && <p className="mt-0.5 text-[11px] leading-tight text-[var(--kn-text-muted)]">{hint}</p>}
      </div>
    </div>
  );
}
