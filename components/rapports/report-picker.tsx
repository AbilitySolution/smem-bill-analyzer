"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  MapPin, Wrench, Layers3, Loader2, Download, Check, Radio, Info, Sparkles, X, Calendar, Building2,
} from "lucide-react";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

interface Commune { id: string; nom: string; travaux_debut?: string | null; travaux_estimes?: boolean | null }
interface Site { id: string; nom: string; commune_id: string }

type ReportType = "commune" | "avant_apres" | "synthese";

const REPORTS: { id: ReportType; label: string; desc: string; icon: typeof MapPin }[] = [
  { id: "commune", label: "Par commune", desc: "Séries temporelles kWh/€, détail par site, décomposition tarifaire (HP+HC, ratio HC/HP), TCD.", icon: MapPin },
  { id: "avant_apres", label: "Avant / après travaux", desc: "Moyennes annualisées par site, fenêtre de travaux exclue (dates SMEM ou date de bascule saisie) + histogrammes.", icon: Wrench },
  { id: "synthese", label: "Synthèse", desc: "Portefeuille consolidé : évolution temporelle + avant/après par commune, TCD.", icon: Layers3 },
];

/** Générateur de rapport Excel — flux unique : type de rapport + périmètre + data logger. */
export function ReportPicker({ communes, sites, preselectedIds = [] }: { communes: Commune[]; sites: Site[]; preselectedIds?: string[] }) {
  const router = useRouter();
  const [report, setReport] = useState<ReportType>("commune");
  const [communeId, setCommuneId] = useState("");
  const [siteIds, setSiteIds] = useState<Set<string>>(new Set());
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cutover, setCutover] = useState("");
  const [dataLogger, setDataLogger] = useState(false);
  const [usePre, setUsePre] = useState(preselectedIds.length > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsCommune = report === "commune" || report === "avant_apres";
  const sitesOfCommune = useMemo(
    () => (communeId ? sites.filter((s) => s.commune_id === communeId) : sites),
    [sites, communeId],
  );
  const selectedCommune = communes.find((c) => c.id === communeId);
  // Avant/après sans dates de travaux au référentiel → date de bascule obligatoire.
  const needsCutover = report === "avant_apres" && !!selectedCommune && !selectedCommune.travaux_debut;
  const ready = (!needsCommune || !!communeId) && (!needsCutover || !!cutover);

  const toggleSite = (id: string) =>
    setSiteIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function generate() {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/reports", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          report,
          communeId: needsCommune ? communeId : undefined,
          siteIds: siteIds.size ? [...siteIds] : undefined,
          ids: usePre ? preselectedIds : undefined,
          from: from || undefined,
          to: to || undefined,
          cutover: cutover || undefined,
          dataLogger,
        }),
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
      {/* 1. Type de rapport */}
      <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">1 · Type de rapport</p>
      <div className="grid gap-2 sm:grid-cols-3">
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

      {/* 2. Périmètre */}
      <p className="mb-2 mt-4 text-[12px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">2 · Périmètre</p>

      {usePre && (
        <div className="mb-3 flex items-center justify-between rounded-lg border border-[#fed7aa] bg-[var(--kn-yellow-soft)] px-3 py-2">
          <span className="flex items-center gap-2 text-[12px] font-medium text-[#9a3412]">
            <Sparkles className="size-3.5" /> {preselectedIds.length} facture{preselectedIds.length > 1 ? "s" : ""} présélectionnée{preselectedIds.length > 1 ? "s" : ""} depuis Mes documents
          </span>
          <button onClick={() => { setUsePre(false); router.replace("/rapport-excel"); }}
            className="flex items-center gap-1 text-[12px] font-medium text-[#9a3412] hover:underline">
            <X className="size-3.5" /> Retirer la sélection
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-[var(--kn-panel)] p-3">
        {needsCommune && (
          <label className="flex items-center gap-2 text-[12px] text-[var(--kn-text-muted)]">
            <MapPin className="size-3.5" /> Commune
            <select value={communeId} onChange={(e) => { setCommuneId(e.target.value); setSiteIds(new Set()); }}
              className="h-9 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2 text-[13px] text-[var(--kn-text)] focus:border-[#f97316] focus:outline-none">
              <option value="">Choisir…</option>
              {communes.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
            </select>
          </label>
        )}
        <label className="flex items-center gap-1.5 text-[12px] text-[var(--kn-text-muted)]">
          <Calendar className="size-3.5" /> Du
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="h-9 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2 text-[13px] text-[var(--kn-text)] focus:border-[#f97316] focus:outline-none" />
          Au
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="h-9 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2 text-[13px] text-[var(--kn-text)] focus:border-[#f97316] focus:outline-none" />
        </label>
        {report === "avant_apres" && selectedCommune?.travaux_estimes && (
          <span className="flex items-center gap-1 rounded-full bg-[var(--kn-yellow-soft)] px-2 py-0.5 text-[11px] text-[#9a3412]">
            <Info className="size-3" /> dates de travaux estimées pour cette commune
          </span>
        )}
        {needsCutover && (
          <label className="flex items-center gap-1.5 text-[12px] text-[var(--kn-text-muted)]">
            <Wrench className="size-3.5" /> Date de bascule avant/après
            <input type="date" value={cutover} onChange={(e) => setCutover(e.target.value)}
              className="h-9 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2 text-[13px] text-[var(--kn-text)] focus:border-[#f97316] focus:outline-none" />
            <span className="flex items-center gap-1 rounded-full bg-[var(--kn-yellow-soft)] px-2 py-0.5 text-[11px] text-[#9a3412]">
              <Info className="size-3" /> pas de dates de travaux au référentiel — indiquez la fin des travaux
            </span>
          </label>
        )}
      </div>

      {report !== "avant_apres" && (
        <div className="mt-2 rounded-lg bg-[var(--kn-panel)] p-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-[12px] text-[var(--kn-text-muted)]">
            <Building2 className="size-3.5" /> Sites (optionnel — tous si aucun choisi)
          </p>
          <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
            {sitesOfCommune.map((s) => {
              const on = siteIds.has(s.id);
              return (
                <button key={s.id} onClick={() => toggleSite(s.id)}
                  className={cx("rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors",
                    on ? "border-[#f97316] bg-[#f97316] text-white" : "border-[var(--kn-border)] bg-[var(--kn-card)] text-[var(--kn-text-muted)] hover:border-[#fb923c]")}>
                  {s.nom}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 3. Options + génération */}
      <p className="mb-2 mt-4 text-[12px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">3 · Options</p>
      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-[var(--kn-panel)] p-3">
        <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--kn-text)]"
          title="Section distincte des analyses tarifaires : consommation quotidienne + historique de coupures.">
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
          {busy ? "Génération…" : "Générer le rapport Excel"}
        </button>
      </div>
      {!ready && (
        <p className="mt-2 text-[12px] text-[var(--kn-text-muted)]">
          {needsCutover && communeId ? "Saisissez une date de bascule avant/après pour cette commune." : "Choisissez une commune pour ce type de rapport."}
        </p>
      )}
      {error && <p className="mt-2 text-[13px] text-[#d33]">{error}</p>}

      <p className="mt-3 text-[11px] text-[var(--kn-text-muted)]">
        Classeurs Excel construits sur les champs réellement extraits des factures : séries temporelles (axes et unités affichés),
        tableaux croisés dynamiques natifs (actualisés à l&apos;ouverture), décomposition Base / HP / HC / part fixe / taxes avec
        totaux HP+HC et ratio HC/HP. Les périodes de facturation sont ventilées au pro-rata des jours — y compris les factures
        de rattrapage multi-années — et les avoirs sont déduits des totaux.
      </p>
    </section>
  );
}
