"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  MapPin, Layers3, Loader2, Download, Check, Sparkles, X, Calendar,
} from "lucide-react";
import type { InvoiceScope } from "@/lib/data/invoice-scope";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

interface Commune { id: string; nom: string; travaux_debut?: string | null; travaux_estimes?: boolean | null }

// « avant_apres » reste supporté côté générateur mais n'est plus proposé ici — voir report-picker.tsx.
type ReportType = "commune" | "synthese";

const REPORTS: { id: ReportType; label: string; desc: string; icon: typeof MapPin }[] = [
  { id: "commune", label: "Par commune", desc: "Séries temporelles kWh/€, détail par site, TCD.", icon: MapPin },
  { id: "synthese", label: "Synthèse", desc: "Portefeuille consolidé de la sélection + TCD.", icon: Layers3 },
];

/**
 * Modal de génération d'un rapport à partir des factures sélectionnées dans Mes documents.
 * S'ouvre automatiquement à l'arrivée sur /rapport-excel?ids=… ; laisse choisir le type
 * de rapport (appliqué à la sélection) puis génère le classeur via /api/reports.
 */
export function ReportModal({ ids, communes, scope }: { ids: string[]; communes: Commune[]; scope: InvoiceScope }) {
  const router = useRouter();
  const [open, setOpen] = useState(ids.length > 0);
  const [report, setReport] = useState<ReportType>("synthese");
  const [communeId, setCommuneId] = useState(communes.length === 1 ? communes[0].id : "");
  // null = « pas encore touché » : la borne suit alors le périmètre choisi.
  const [fromEdit, setFromEdit] = useState<string | null>(null);
  const [toEdit, setToEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsCommune = report === "commune";
  const ready = !needsCommune || !!communeId;

  // Mêmes bornes préremplies que sur la page (voir report-picker.tsx) : période couverte
  // par la commune choisie, sinon par l'ensemble des documents.
  const defaults = report === "commune" && communeId ? scope.parCommune[communeId] : scope.global;
  const from = fromEdit ?? defaults?.from ?? "";
  const to = toEdit ?? defaults?.to ?? "";
  const resetDates = () => { setFromEdit(null); setToEdit(null); };

  function close() {
    setOpen(false);
    router.replace("/rapport-excel");
  }

  async function generate() {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/reports", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          report,
          communeId: needsCommune ? communeId : undefined,
          ids,
          from: from || undefined,
          to: to || undefined,
        }),
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); setError(j.error ?? "Erreur de génération."); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `rapport-${report}-selection.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      close();
    } catch {
      setError("Erreur réseau lors de la génération.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && close()}>
      <div className="w-full max-w-lg rounded-2xl bg-[var(--kn-card)] p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-heading text-[16px] font-bold text-[var(--kn-text)]">
            <Sparkles className="size-4 text-[#ea580c]" /> Rapport personnalisé
          </h3>
          <button onClick={close} className="rounded-lg p-1 text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)]" aria-label="Fermer">
            <X className="size-4" />
          </button>
        </div>
        <p className="mb-4 text-[12px] text-[var(--kn-text-muted)]">
          {ids.length} facture{ids.length > 1 ? "s" : ""} sélectionnée{ids.length > 1 ? "s" : ""} depuis Mes documents.
          Choisissez le type de rapport à générer sur cette sélection.
        </p>

        {/* Type */}
        <div className="grid gap-2 sm:grid-cols-2">
          {REPORTS.map((r) => {
            const on = report === r.id;
            return (
              <button key={r.id} onClick={() => { setReport(r.id); resetDates(); }}
                className={cx("flex flex-col gap-1 rounded-lg border p-2.5 text-left transition-colors",
                  on ? "border-[#f97316]" : "border-[var(--kn-border)] hover:border-[#fb923c]")}>
                <span className={cx("flex size-6 items-center justify-center rounded-md",
                  on ? "bg-[#f97316] text-white" : "bg-[var(--kn-yellow-soft)] text-[#ea580c]")}>
                  {on ? <Check className="size-3.5" strokeWidth={3} /> : <r.icon className="size-3.5" />}
                </span>
                <span className="text-[13px] font-medium text-[var(--kn-text)]">{r.label}</span>
                <span className="text-[11px] text-[var(--kn-text-muted)]">{r.desc}</span>
              </button>
            );
          })}
        </div>

        {/* Périmètre commune (types qui l'exigent) */}
        {needsCommune && (
          <label className="mt-3 flex items-center gap-2 text-[12px] text-[var(--kn-text-muted)]">
            <MapPin className="size-3.5" /> Commune
            <select value={communeId} onChange={(e) => { setCommuneId(e.target.value); resetDates(); }}
              className="h-9 flex-1 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2 text-[13px] text-[var(--kn-text)] focus:border-[#f97316] focus:outline-none">
              <option value="">Choisir…</option>
              {communes.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
            </select>
          </label>
        )}
        {/* Options */}
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-[var(--kn-panel)] p-3">
          <label className="flex items-center gap-1.5 text-[12px] text-[var(--kn-text-muted)]">
            <Calendar className="size-3.5" /> Du
            <input type="date" value={from} onChange={(e) => setFromEdit(e.target.value)}
              className="h-8 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2 text-[13px] focus:border-[#f97316] focus:outline-none" />
            Au
            <input type="date" value={to} onChange={(e) => setToEdit(e.target.value)}
              className="h-8 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2 text-[13px] focus:border-[#f97316] focus:outline-none" />
          </label>
        </div>

        {error && <p className="mt-2 text-[13px] text-[#d33]">{error}</p>}
        {!ready && (
          <p className="mt-2 text-[12px] text-[var(--kn-text-muted)]">Choisissez une commune pour ce type de rapport.</p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={close} disabled={busy} className="rounded-lg border border-[var(--kn-border)] px-3 py-2 text-[13px] font-medium hover:bg-[var(--kn-active)]">
            Annuler
          </button>
          <button onClick={generate} disabled={busy || !ready}
            className="flex items-center gap-2 rounded-lg bg-[#f97316] px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#ea580c] disabled:opacity-50">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            {busy ? "Génération…" : "Générer"}
          </button>
        </div>
      </div>
    </div>
  );
}
