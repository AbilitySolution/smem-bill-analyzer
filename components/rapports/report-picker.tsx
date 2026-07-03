"use client";

import { useMemo, useState } from "react";
import {
  Building2, MapPin, Layers3, TrendingUp, Wrench, Loader2, Download, Check, Radio, Info,
} from "lucide-react";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

interface Commune { id: string; nom: string }
interface Site { id: string; nom: string; commune_id: string }

type ReportType = "commune" | "site" | "synthese" | "avant_apres" | "tarifs";

const REPORTS: { id: ReportType; label: string; desc: string; icon: typeof MapPin }[] = [
  { id: "commune", label: "Rapport par commune", desc: "Sites de la commune : semestres S1/S2 (€ et kWh), décomposition tarifaire, TCD.", icon: MapPin },
  { id: "site", label: "Rapport par site", desc: "Fiche d'un site : évolution par poste (Base/HP/HC), part fixe, taxes.", icon: Building2 },
  { id: "synthese", label: "Rapport de synthèse", desc: "Vue consolidée toutes communes + analyse avant/après travaux.", icon: Layers3 },
  { id: "avant_apres", label: "Avant / après rénovation (PEPP)", desc: "Impact des travaux d'éclairage public : baisse de conso vs évolution des dépenses.", icon: Wrench },
  { id: "tarifs", label: "Évolution tarifaire & effet prix-volume", desc: "Prix moyen c€/kWh par poste, décomposition effet prix / effet volume.", icon: TrendingUp },
];

/** Rapports prédéfinis (générés côté serveur : graphiques natifs + TCD natifs Excel). */
export function ReportPicker({ communes, sites }: { communes: Commune[]; sites: Site[] }) {
  const [report, setReport] = useState<ReportType>("commune");
  const [communeId, setCommuneId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [dataLogger, setDataLogger] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sitesOfCommune = useMemo(
    () => (communeId ? sites.filter((s) => s.commune_id === communeId) : sites),
    [sites, communeId],
  );

  const needsCommune = report === "commune";
  const needsSite = report === "site";
  const ready = (!needsCommune || !!communeId) && (!needsSite || !!siteId);

  async function generate() {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/reports", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ report, communeId: needsCommune ? communeId : undefined, siteId: needsSite ? siteId : undefined, dataLogger }),
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); setError(j.error ?? "Erreur de génération."); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `rapport-${report}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Erreur réseau lors de la génération.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-4">
      <h3 className="text-[14px] font-semibold text-[var(--kn-text)]">Rapports prédéfinis</h3>
      <p className="mb-3 text-[12px] text-[var(--kn-text-muted)]">
        Classeurs Excel complets : graphiques intégrés, tableaux croisés dynamiques natifs, vues S1/S2 et annuelles,
        décomposition Base / HP / HC / part fixe / taxes. Les périodes de facturation sont ventilées au pro-rata des jours.
      </p>

      {/* Choix du rapport */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {REPORTS.map((r) => {
          const on = report === r.id;
          return (
            <button key={r.id} onClick={() => setReport(r.id)}
              className={cx("flex items-start gap-2 rounded-lg border p-2.5 text-left transition-colors",
                on ? "border-[#f97316]" : "border-[var(--kn-border)] hover:border-[#fb923c]")}>
              <span className={cx("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md",
                on ? "bg-[#f97316] text-white" : "bg-[var(--kn-yellow-soft)] text-[#ea580c]")}>
                {on ? <Check className="size-3.5" strokeWidth={3} /> : <r.icon className="size-3.5" />}
              </span>
              <span>
                <span className="block text-[13px] font-medium text-[var(--kn-text)]">{r.label}</span>
                <span className="block text-[11px] text-[var(--kn-text-muted)]">{r.desc}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Paramètres + data logger + Générer */}
      <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-[var(--kn-panel)] p-3">
        {needsCommune && (
          <label className="flex items-center gap-2 text-[12px] text-[var(--kn-text-muted)]">
            Commune
            <select value={communeId} onChange={(e) => setCommuneId(e.target.value)}
              className="h-9 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2 text-[13px] text-[var(--kn-text)] focus:border-[#f97316] focus:outline-none">
              <option value="">Choisir…</option>
              {communes.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
            </select>
          </label>
        )}
        {needsSite && (
          <>
            <label className="flex items-center gap-2 text-[12px] text-[var(--kn-text-muted)]">
              Commune
              <select value={communeId} onChange={(e) => { setCommuneId(e.target.value); setSiteId(""); }}
                className="h-9 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2 text-[13px] text-[var(--kn-text)] focus:border-[#f97316] focus:outline-none">
                <option value="">Toutes</option>
                {communes.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 text-[12px] text-[var(--kn-text-muted)]">
              Site
              <select value={siteId} onChange={(e) => setSiteId(e.target.value)}
                className="h-9 max-w-56 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2 text-[13px] text-[var(--kn-text)] focus:border-[#f97316] focus:outline-none">
                <option value="">Choisir…</option>
                {sitesOfCommune.map((s) => <option key={s.id} value={s.id}>{s.nom}</option>)}
              </select>
            </label>
          </>
        )}

        <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--kn-text)]" title="Section distincte des analyses tarifaires : allumage/extinction, puissance instantanée, coupures, profil de charge.">
          <input type="checkbox" checked={dataLogger} onChange={(e) => setDataLogger(e.target.checked)} className="accent-[#f97316]" />
          <Radio className="size-3.5 text-[var(--kn-text-muted)]" />
          Inclure les données du connecteur data logger
        </label>
        {dataLogger && (
          <span className="flex items-center gap-1 rounded-full bg-[var(--kn-yellow-soft)] px-2 py-0.5 text-[11px] text-[#9a3412]">
            <Info className="size-3" /> connecteur non raccordé — données de démonstration
          </span>
        )}

        <button onClick={generate} disabled={busy || !ready}
          className="ml-auto flex items-center gap-2 rounded-lg bg-[#f97316] px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#ea580c] disabled:opacity-50">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          {busy ? "Génération…" : "Générer le rapport"}
        </button>
      </div>
      {error && <p className="mt-2 text-[13px] text-[#d33]">{error}</p>}
    </section>
  );
}
