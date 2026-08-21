"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  MapPin, Layers3, Loader2, Download, Check, Sparkles, X, Calendar, Building2,
} from "lucide-react";
import type { InvoiceScope } from "@/lib/data/invoice-scope";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

interface Commune { id: string; nom: string; travaux_debut?: string | null; travaux_estimes?: boolean | null }
interface Site { id: string; nom: string; commune_id: string }

// Le rapport « avant_apres » reste supporté côté générateur (app/api/reports + scripts/reports),
// mais n'est plus proposé dans l'interface : la fenêtre de travaux SMEM n'est pas fiable sur
// l'ensemble des communes, et un avant/après calculé sur des dates estimées induit en erreur.
type ReportType = "commune" | "synthese";

const REPORTS: { id: ReportType; label: string; desc: string; icon: typeof MapPin }[] = [
  { id: "commune", label: "Par commune", desc: "Séries temporelles kWh/€, détail par site, décomposition tarifaire (HP+HC, ratio HC/HP), TCD.", icon: MapPin },
  { id: "synthese", label: "Synthèse", desc: "Portefeuille consolidé : évolution temporelle par commune, TCD.", icon: Layers3 },
];

/** Générateur de rapport Excel — flux unique : type de rapport + périmètre. */
export function ReportPicker({
  communes, sites, preselectedIds = [], scope,
}: {
  communes: Commune[];
  sites: Site[];
  preselectedIds?: string[];
  scope: InvoiceScope;
}) {
  const router = useRouter();
  const [report, setReport] = useState<ReportType>("commune");
  const [communeId, setCommuneId] = useState("");
  const [siteIds, setSiteIds] = useState<Set<string>>(new Set());
  // null = « pas encore touché » : la borne suit alors le périmètre choisi (voir plus bas).
  const [fromEdit, setFromEdit] = useState<string | null>(null);
  const [toEdit, setToEdit] = useState<string | null>(null);
  const [usePre, setUsePre] = useState(preselectedIds.length > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsCommune = report === "commune";
  const sitesOfCommune = useMemo(
    () => (communeId ? sites.filter((s) => s.commune_id === communeId) : sites),
    [sites, communeId],
  );
  const ready = !needsCommune || !!communeId;

  // Bornes réelles des documents : celles de la commune choisie, sinon celles de tout
  // le portefeuille (cas de la synthèse). Préremplies plutôt que laissées vides — sans
  // elles l'utilisateur doit deviner la profondeur d'historique dont il dispose.
  // Changer de commune ou de type remet les bornes sur le nouveau périmètre : la remise
  // à null se fait dans les gestionnaires d'événements, pas dans un effet.
  const defaults = report === "commune" && communeId ? scope.parCommune[communeId] : scope.global;
  const from = fromEdit ?? defaults?.from ?? "";
  const to = toEdit ?? defaults?.to ?? "";
  const resetDates = () => { setFromEdit(null); setToEdit(null); };

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
      <div className="grid gap-2 sm:grid-cols-2">
        {REPORTS.map((r) => {
          const on = report === r.id;
          return (
            <button key={r.id} onClick={() => { setReport(r.id); resetDates(); }}
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
            <select value={communeId} onChange={(e) => { setCommuneId(e.target.value); setSiteIds(new Set()); resetDates(); }}
              className="h-9 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2 text-[13px] text-[var(--kn-text)] focus:border-[#f97316] focus:outline-none">
              <option value="">Choisir…</option>
              {communes.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
            </select>
          </label>
        )}
        <label className="flex items-center gap-1.5 text-[12px] text-[var(--kn-text-muted)]">
          <Calendar className="size-3.5" /> Du
          <input type="date" value={from} onChange={(e) => setFromEdit(e.target.value)}
            className="h-9 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2 text-[13px] text-[var(--kn-text)] focus:border-[#f97316] focus:outline-none" />
          Au
          <input type="date" value={to} onChange={(e) => setToEdit(e.target.value)}
            className="h-9 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2 text-[13px] text-[var(--kn-text)] focus:border-[#f97316] focus:outline-none" />
        </label>
        {defaults && (
          <span className="text-[11px] text-[var(--kn-text-muted)]">
            période couverte par les documents{needsCommune && communeId ? " de cette commune" : ""}
          </span>
        )}
      </div>

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

      {/* 3. Génération */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {!ready && (
          <p className="text-[12px] text-[var(--kn-text-muted)]">
            Choisissez une commune pour ce type de rapport.
          </p>
        )}
        <button onClick={generate} disabled={busy || !ready}
          className="ml-auto flex items-center gap-2 rounded-lg bg-[#f97316] px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#ea580c] disabled:opacity-50">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          {busy ? "Génération…" : "Générer le rapport Excel"}
        </button>
      </div>
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
