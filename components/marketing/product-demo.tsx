"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle, Building2, CalendarRange, CheckCircle2, Euro, ExternalLink, FileText, Hash, Lightbulb, ScanText, Zap,
} from "lucide-react";
import { AbilitySidebar } from "@/components/koncile/kn-sidebar";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

type Severity = "low" | "medium" | "high";
const SEVERITY_LABEL: Record<Severity, string> = { low: "Faible", medium: "Moyenne", high: "Élevée" };
const SEVERITY_COLOR: Record<Severity, string> = { low: "#94a3b8", medium: "#f59e0b", high: "#ef4444" };

const FIELDS: { label: string; value: string; precision: number }[] = [
  { label: "N° de facture", value: "FACTURE-2026-0842", precision: 0.99 },
  { label: "Date de facture", value: "12/06/2026", precision: 0.98 },
  { label: "Échéance", value: "27/06/2026", precision: 0.95 },
  { label: "Site", value: "ÉCLAIRAGE PUBLIC BOURG", precision: 0.93 },
  { label: "Consommation", value: "18 420 kWh", precision: 0.97 },
  { label: "Total TTC", value: "3 184 €", precision: 0.99 },
];

const ANOMALIES: { severity: Severity; message: string; extra: string; meta: string }[] = [
  { severity: "high", message: "Consommation en hausse de 340% vs même saison N-1", extra: "", meta: "FACTURE-2026-0731 · Éclairage public · Le Carbet" },
  { severity: "medium", message: "Écart de coût au kWh", extra: "(+41 €)", meta: "FACTURE-2026-0688 · Bâtiment mairie · Fort-de-France" },
  { severity: "low", message: "Donnée de consommation manquante sur la période", extra: "", meta: "FACTURE-2026-0655 · Éclairage public · Schoelcher" },
];

const DOCS: { number: string; date: string; site: string; commune: string; category: "batiment" | "eclairage_public"; confidence: number; kwh: string; total: string }[] = [
  { number: "FACTURE-2026-0842", date: "12/06/2026", site: "Éclairage public Bourg", commune: "Le Carbet", category: "eclairage_public", confidence: 96, kwh: "18 420 kWh", total: "3 184 €" },
  { number: "FACTURE-2026-0839", date: "10/06/2026", site: "Mairie annexe", commune: "Fort-de-France", category: "batiment", confidence: 91, kwh: "6 210 kWh", total: "1 042 €" },
  { number: "FACTURE-2026-0831", date: "08/06/2026", site: "Éclairage public Centre", commune: "Schoelcher", category: "eclairage_public", confidence: 88, kwh: "9 870 kWh", total: "1 705 €" },
  { number: "FACTURE-2026-0828", date: "05/06/2026", site: "École primaire", commune: "Le Lamentin", category: "batiment", confidence: 97, kwh: "4 130 kWh", total: "712 €" },
];

const TABS = [
  { id: "documents" as const, label: "Mes documents", icon: FileText },
  { id: "extraction" as const, label: "Extraction IA", icon: ScanText },
  { id: "anomalies" as const, label: "Détection d'anomalies", icon: AlertTriangle },
];
const TAB_ORDER = TABS.map((t) => t.id);

export function ProductDemo() {
  const [tab, setTab] = useState<(typeof TAB_ORDER)[number]>("documents");

  useEffect(() => {
    const id = setInterval(() => {
      setTab((t) => TAB_ORDER[(TAB_ORDER.indexOf(t) + 1) % TAB_ORDER.length]);
    }, 5000);
    return () => clearInterval(id);
  }, [tab]);

  return (
    <div className="mx-auto max-w-5xl">
      <style>{`
        @keyframes demo-progress { from { width: 0%; } to { width: 100%; } }
        .demo-progress { animation: demo-progress 5s linear forwards; }
        @media (prefers-reduced-motion: reduce) {
          .demo-progress { animation: none; width: 100%; }
        }
      `}</style>

      <div className="mb-4 flex items-center justify-center gap-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cx(
              "flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12px] font-medium transition-colors",
              tab === t.id
                ? "border-[#f97316] bg-[#f97316] text-white"
                : "border-[var(--kn-border)] text-[var(--kn-text-muted)] hover:border-[#fb923c]",
            )}
          >
            <t.icon className="size-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-[var(--kn-border)] bg-[var(--kn-card)] shadow-2xl">
        {/* Barre de fenêtre — évoque un navigateur, pas une vidéo réelle */}
        <div className="flex items-center gap-2 border-b border-[var(--kn-border)] bg-[var(--kn-panel)] px-4 py-2.5">
          <span className="size-2.5 rounded-full bg-[#f43f5e]" />
          <span className="size-2.5 rounded-full bg-[#f59e0b]" />
          <span className="size-2.5 rounded-full bg-[#22c55e]" />
          <span className="ml-3 truncate rounded-md bg-[var(--kn-value-box)] px-3 py-1 text-[11px] text-[var(--kn-text-muted)]">
            app.ability.energy/{tab === "documents" ? "documents" : tab === "extraction" ? "documents/extraction" : "anomalies"}
          </span>
          <span className="ml-auto hidden shrink-0 items-center gap-1.5 text-[11px] font-medium text-[var(--kn-text-muted)] sm:flex">
            <span className="relative flex size-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#f97316] opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-[#f97316]" />
            </span>
            Aperçu du produit
          </span>
        </div>

        {/* Barre de progression du cycle auto */}
        <div key={tab} className="h-[2px] w-full bg-[var(--kn-border)]">
          <div className="demo-progress h-full bg-[#f97316]" />
        </div>

        <div className="flex h-[440px]">
          <div className="pointer-events-none hidden shrink-0 border-r border-[var(--kn-border)] md:block">
            <AbilitySidebar user={{ email: "demo@smem.mq", roleLabel: "Administrateur" }} isAdmin />
          </div>

          <div className="min-w-0 flex-1 overflow-hidden bg-[var(--kn-page)]">
            {tab === "documents" ? <DocumentsScreen /> : tab === "extraction" ? <ExtractionScreen /> : <AnomaliesScreen />}
          </div>
        </div>
      </div>
    </div>
  );
}

function DocumentsScreen() {
  const catLabel = (c: "batiment" | "eclairage_public") => (c === "batiment" ? "Bâtiment" : "Éclairage public");
  const confColor = (v: number) => (v >= 85 ? "#16a34a" : v >= 60 ? "#d97706" : "#dc2626");

  return (
    <div className="flex h-full flex-col p-5">
      <div className="mb-4 grid grid-cols-4 gap-3">
        <Kpi icon={<Hash className="size-4" />} label="Factures" value="4" />
        <Kpi icon={<Euro className="size-4" />} label="Total TTC" value="6 643 €" />
        <Kpi icon={<Zap className="size-4" />} label="Consommation" value="38 630 kWh" />
        <Kpi icon={<CalendarRange className="size-4" />} label="Période" value="Juin 2026" />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-[var(--kn-border)]">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-[var(--kn-border)] bg-[var(--kn-panel)] text-left text-[var(--kn-text-muted)]">
              <th className="px-4 py-2.5 font-medium">N° facture</th>
              <th className="px-4 py-2.5 font-medium">Date</th>
              <th className="px-4 py-2.5 font-medium">Site</th>
              <th className="px-4 py-2.5 font-medium">Catégorie</th>
              <th className="px-4 py-2.5 font-medium">Confiance</th>
              <th className="px-4 py-2.5 text-right font-medium">Total TTC</th>
            </tr>
          </thead>
          <tbody>
            {DOCS.map((d) => (
              <tr key={d.number} className="border-b border-[var(--kn-border)] last:border-0">
                <td className="px-4 py-2.5 font-medium text-[var(--kn-text)]">{d.number}</td>
                <td className="px-4 py-2.5 text-[var(--kn-text-muted)]">{d.date}</td>
                <td className="px-4 py-2.5">{d.site}</td>
                <td className="px-4 py-2.5">
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--kn-value-box)] px-2 py-0.5 text-[11px] text-[var(--kn-text-muted)]">
                    {d.category === "batiment" ? <Building2 className="size-3" /> : <Lightbulb className="size-3" />}
                    {catLabel(d.category)}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span className="inline-flex items-center gap-1 text-[12px] font-medium tabular-nums" style={{ color: confColor(d.confidence) }}>
                    <span className="size-1.5 rounded-full" style={{ background: confColor(d.confidence) }} />
                    {d.confidence}%
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right font-medium tabular-nums">{d.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Kpi({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--kn-yellow-soft)] text-[#ea580c]">{icon}</span>
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--kn-text-muted)]">{label}</p>
        <p className="truncate text-[16px] font-bold tabular-nums text-[var(--kn-text)]">{value}</p>
      </div>
    </div>
  );
}

function ExtractionScreen() {
  const extractionTabs = ["Facture", "Client & contrat", "Consommation", "Taxes & part fixe"];
  return (
    <div className="flex h-full flex-col p-5">
      <div className="mb-3 flex items-center gap-2">
        <ScanText className="size-4 text-[#ea580c]" />
        <h3 className="text-[13px] font-semibold text-[var(--kn-text)]">Extraction — FACTURE-2026-0842</h3>
        <span className="ml-auto rounded-full bg-[var(--kn-badge-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--kn-badge-fg)]">96% de confiance</span>
      </div>

      <div className="flex h-full min-h-0 flex-col rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)]">
        <div className="flex shrink-0 items-center gap-4 overflow-x-auto border-b border-[var(--kn-border)] px-4 text-[13px]">
          {extractionTabs.map((t, i) => (
            <span
              key={t}
              className={cx(
                "relative flex h-10 shrink-0 items-center whitespace-nowrap font-medium",
                i === 0 ? "text-[var(--kn-text)]" : "text-[var(--kn-text-muted)]",
              )}
            >
              {t}
              {i === 0 && <span className="absolute -bottom-px left-0 h-0.5 w-full bg-[#f97316]" />}
            </span>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <div className="flex items-center justify-between px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--kn-text-muted)]">
            <span>Champ</span><span>Précision</span>
          </div>
          {FIELDS.map((f) => (
            <div key={f.label} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5">
              <span className="text-[12px] font-medium text-[var(--kn-text-muted)]">{f.label}</span>
              <div className="flex items-center gap-2">
                <span className="rounded px-1.5 py-0.5 text-[13px] font-medium text-[var(--kn-text)]">{f.value}</span>
                <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-[var(--kn-text-muted)]">
                  {Math.round(f.precision * 100)}%
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AnomaliesScreen() {
  return (
    <div className="flex h-full flex-col p-5">
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle className="size-4 text-[#ea580c]" />
        <h3 className="text-[13px] font-semibold text-[var(--kn-text)]">Anomalies détectées</h3>
        <span className="ml-auto rounded-full bg-[var(--kn-yellow-soft)] px-2 py-0.5 text-[11px] font-medium text-[#9a3412]">{ANOMALIES.length} ouvertes</span>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {(["Toutes", "Élevée", "Moyenne", "Faible"] as const).map((s, i) => (
          <span
            key={s}
            className={cx(
              "rounded-full border px-2.5 py-1 text-[12px] font-medium",
              i === 0 ? "border-[#f97316] bg-[#f97316] text-white" : "border-[var(--kn-border)] text-[var(--kn-text-muted)]",
            )}
          >
            {s}
          </span>
        ))}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {ANOMALIES.map((a) => (
          <div key={a.message} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-3">
            <div className="flex min-w-0 items-start gap-3">
              <span
                className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                style={{ color: SEVERITY_COLOR[a.severity], background: `${SEVERITY_COLOR[a.severity]}1f` }}
              >
                <AlertTriangle className="size-3" /> {SEVERITY_LABEL[a.severity]}
              </span>
              <div className="min-w-0">
                <p className="text-[13px] text-[var(--kn-text)]">
                  {a.message}
                  {a.extra && <span className="ml-1.5 font-semibold text-[#ea580c]">{a.extra}</span>}
                </p>
                <span className="mt-0.5 inline-flex items-center gap-1 text-[12px] text-[var(--kn-text-muted)]">
                  {a.meta} <ExternalLink className="size-3" />
                </span>
              </div>
            </div>
            <span className="shrink-0 rounded-lg border border-[var(--kn-border)] px-3 py-1.5 text-[12px] font-medium text-[var(--kn-text-muted)]">
              Marquer résolue
            </span>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-xl border border-dashed border-[var(--kn-border)] px-3 py-2 text-[12px] text-[var(--kn-text-muted)]">
        <CheckCircle2 className="size-3.5 text-[#16a34a]" />
        Anomalies vérifiées automatiquement à chaque nouvelle facture importée.
      </div>
    </div>
  );
}
