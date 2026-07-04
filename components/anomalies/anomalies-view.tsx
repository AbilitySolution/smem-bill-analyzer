"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  BarChart, Bar, Cell, ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { AlertTriangle, ShieldAlert, MapPin, CheckCircle2, Info, ExternalLink, RotateCcw, History } from "lucide-react";
import type { InvoiceDoc } from "@/lib/data/invoices";
import {
  loadResolved, saveResolved, anomalyKey, SEVERITY_LABEL, SEVERITY_COLOR, type Severity,
} from "@/lib/data/anomalies";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");
const eur = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 0 }) + " €";
const kwhFmt = (n: number) => n.toLocaleString("fr-FR") + " kWh";
const SEV_ORDER: Severity[] = ["high", "medium", "low"];

interface FeedItem {
  key: string; invoiceId: string; number: string; site: string; commune: string;
  severity: Severity; message: string; type: string;
}

// Extracteurs tolérants pour les survols recharts (payload selon la version).
const pointId = (d: unknown): string | null => {
  const o = d as { id?: string; payload?: { id?: string } } | null;
  return o?.id ?? o?.payload?.id ?? null;
};
const barSeverity = (d: unknown): Severity | null => {
  const o = d as { severity?: Severity; payload?: { severity?: Severity } } | null;
  return o?.severity ?? o?.payload?.severity ?? null;
};

export function AnomaliesView({ docs, focus }: { docs: InvoiceDoc[]; focus?: string }) {
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Severity | "all">("all");
  const [hoverInvoice, setHoverInvoice] = useState<string | null>(null);
  const [hoverSeverity, setHoverSeverity] = useState<Severity | null>(null);
  useEffect(() => { setResolved(loadResolved()); }, []);

  const allItems: FeedItem[] = useMemo(() => {
    const items: FeedItem[] = [];
    for (const d of docs) {
      for (const a of d.anomalies ?? []) {
        items.push({ key: anomalyKey(d.id, a.type), invoiceId: d.id, number: d.number, site: d.site, commune: d.commune, severity: a.severity, message: a.message, type: a.type });
      }
    }
    return items;
  }, [docs]);

  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  const open = useMemo(() => {
    return allItems.filter((i) => !resolved.has(i.key))
      .sort((a, b) => (a.invoiceId === focus ? -1 : b.invoiceId === focus ? 1 : rank[a.severity] - rank[b.severity]));
  }, [allItems, resolved, focus]);
  const history = useMemo(() => allItems.filter((i) => resolved.has(i.key)), [allItems, resolved]);

  const shown = filter === "all" ? open : open.filter((i) => i.severity === filter);

  const sites = new Set(open.map((i) => i.site)).size;
  const highCount = open.filter((i) => i.severity === "high").length;

  const distribution = SEV_ORDER.map((s) => ({ label: SEVERITY_LABEL[s], severity: s, value: open.filter((i) => i.severity === s).length }))
    .filter((d) => d.value > 0);

  const scatter = useMemo(() => {
    const flaggedIds = new Set(open.map((i) => i.invoiceId));
    return docs
      .filter((d) => d.kwh > 0)
      .map((d) => ({ id: d.id, kwh: d.kwh, amount: d.totalTtc, flagged: flaggedIds.has(d.id), severity: flaggedIds.has(d.id) ? (d.anomalySeverity ?? null) : null }));
  }, [docs, open]);

  function resolve(key: string) {
    setResolved((prev) => { const n = new Set(prev); n.add(key); saveResolved(n); return n; });
  }
  function reopen(key: string) {
    setResolved((prev) => { const n = new Set(prev); n.delete(key); saveResolved(n); return n; });
  }

  const isHot = (it: FeedItem) => it.invoiceId === focus || it.invoiceId === hoverInvoice || it.severity === hoverSeverity;
  const tooltipStyle = { fontSize: 12, borderRadius: 8, background: "var(--kn-card)", border: "1px solid var(--kn-border)", color: "var(--kn-text)" } as const;

  return (
    <div className="mx-auto max-w-5xl px-8 py-6">
      <div className="mb-1 flex items-center gap-2.5">
        <AlertTriangle className="size-6 text-[#f59e0b]" strokeWidth={1.9} />
        <h1 className="font-heading text-2xl font-bold text-[var(--kn-text)]">Anomalies</h1>
        <span className="rounded-full bg-[var(--kn-yellow-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#9a3412]">Version bêta</span>
      </div>

      {/* Disclaimer version bêta */}
      <div className="mb-5 mt-3 flex items-start gap-2.5 rounded-xl border border-[#fed7aa] bg-[var(--kn-yellow-soft)] px-4 py-3">
        <Info className="mt-0.5 size-4 shrink-0 text-[#ea580c]" />
        <p className="text-[13px] text-[var(--kn-text)]">
          Module en <strong>version bêta</strong> — la détection présentée ici est un <strong>contrôle automatique de démonstration</strong> (cohérence des totaux, coût unitaire atypique…).
          La version complète (détection avancée, suivi en base, règles configurables) arrive prochainement.
        </p>
      </div>

      {open.length === 0 && history.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {open.length > 0 && (
            <>
              {/* KPIs */}
              <div className="mb-5 grid grid-cols-3 gap-3">
                <Kpi icon={<AlertTriangle className="size-4" />} label="Alertes ouvertes" value={String(open.length)} />
                <Kpi icon={<MapPin className="size-4" />} label="Sites touchés" value={String(sites)} />
                <Kpi icon={<ShieldAlert className="size-4" />} label="Élevées" value={String(highCount)} />
              </div>

              {/* Graphiques (survol → la carte correspondante « pop ») */}
              <div className="mb-5 grid gap-4 lg:grid-cols-2">
                <Panel title="Distribution par gravité" subtitle="Survolez une barre pour mettre en évidence les alertes">
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={distribution} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--kn-border)" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 12, fill: "var(--kn-text-muted)" }} stroke="var(--kn-border)" />
                      <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: "var(--kn-text-muted)" }} stroke="var(--kn-border)" />
                      <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--kn-active)" }} formatter={(v) => [`${v} alerte(s)`, "Alertes"]} />
                      <Bar dataKey="value" radius={[6, 6, 0, 0]}
                        onMouseEnter={(d) => setHoverSeverity(barSeverity(d))} onMouseLeave={() => setHoverSeverity(null)}>
                        {distribution.map((d) => <Cell key={d.severity} fill={SEVERITY_COLOR[d.severity]} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </Panel>

                <Panel title="Montant vs consommation" subtitle="Survolez un point pour repérer l'alerte associée">
                  <ResponsiveContainer width="100%" height={240}>
                    <ScatterChart margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--kn-border)" />
                      <XAxis type="number" dataKey="kwh" name="Consommation" unit=" kWh" tick={{ fontSize: 11, fill: "var(--kn-text-muted)" }} stroke="var(--kn-border)" />
                      <YAxis type="number" dataKey="amount" name="Montant" unit=" €" tick={{ fontSize: 11, fill: "var(--kn-text-muted)" }} stroke="var(--kn-border)" />
                      <Tooltip contentStyle={tooltipStyle} cursor={{ strokeDasharray: "3 3" }}
                        formatter={(value, name) => (String(name) === "Consommation" ? [kwhFmt(Number(value)), name] : [eur(Number(value)), name])} />
                      <Scatter data={scatter} onMouseEnter={(d) => setHoverInvoice(pointId(d))} onMouseLeave={() => setHoverInvoice(null)}>
                        {scatter.map((p) => (
                          <Cell key={p.id} fill={p.flagged && p.severity ? SEVERITY_COLOR[p.severity] : "#cbd5e1"} r={p.id === hoverInvoice ? 9 : 6} />
                        ))}
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
                </Panel>
              </div>

              {/* Filtre gravité */}
              <div className="mb-3 flex flex-wrap items-center gap-1.5">
                {(["all", ...SEV_ORDER] as const).map((s) => (
                  <button key={s} onClick={() => setFilter(s)}
                    className={cx("rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors",
                      filter === s ? "border-[#f97316] bg-[#f97316] text-white" : "border-[var(--kn-border)] text-[var(--kn-text-muted)] hover:border-[#fb923c]")}>
                    {s === "all" ? "Toutes" : SEVERITY_LABEL[s]}
                  </button>
                ))}
              </div>

              {/* Liste d'actions */}
              <div className="space-y-2">
                {shown.map((it) => (
                  <div key={it.key}
                    onMouseEnter={() => setHoverInvoice(it.invoiceId)} onMouseLeave={() => setHoverInvoice(null)}
                    className={cx("relative flex items-center justify-between gap-3 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-3 transition-all",
                      isHot(it) && "z-10 scale-[1.02] shadow-lg")}>
                    <div className="flex min-w-0 items-start gap-3">
                      <SeverityBadge severity={it.severity} />
                      <div className="min-w-0">
                        <p className="text-[13px] text-[var(--kn-text)]">{it.message}</p>
                        <Link href={`/documents/extraction?id=${it.invoiceId}`} className="mt-0.5 inline-flex items-center gap-1 text-[12px] text-[var(--kn-text-muted)] hover:text-[#ea580c]">
                          {it.number} · {it.site} · {it.commune} <ExternalLink className="size-3" />
                        </Link>
                      </div>
                    </div>
                    <button onClick={() => resolve(it.key)}
                      className="shrink-0 rounded-lg border border-[var(--kn-border)] px-3 py-1.5 text-[12px] font-medium text-[var(--kn-text)] transition-colors hover:bg-[var(--kn-active)]">
                      Marquer résolue
                    </button>
                  </div>
                ))}
                {shown.length === 0 && <p className="py-6 text-center text-[12px] text-[var(--kn-text-muted)]">Aucune alerte ouverte pour ce filtre.</p>}
              </div>
            </>
          )}

          {/* Historique des résolutions */}
          {history.length > 0 && (
            <div className="mt-8">
              <h2 className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-[var(--kn-text)]">
                <History className="size-4 text-[var(--kn-text-muted)]" /> Historique des résolutions
                <span className="rounded-full bg-[var(--kn-value-box)] px-2 py-0.5 text-[11px] text-[var(--kn-text-muted)]">{history.length}</span>
              </h2>
              <div className="space-y-2">
                {history.map((it) => (
                  <div key={it.key} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-panel)] p-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full bg-[#dcfce7] px-2 py-0.5 text-[11px] font-medium text-[#15803d]">
                        <CheckCircle2 className="size-3" /> Résolue
                      </span>
                      <div className="min-w-0">
                        <p className="text-[13px] text-[var(--kn-text-muted)] line-through">{it.message}</p>
                        <span className="text-[12px] text-[var(--kn-text-muted)]">{it.number} · {it.site} · {it.commune}</span>
                      </div>
                    </div>
                    <button onClick={() => reopen(it.key)}
                      className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--kn-border)] px-3 py-1.5 text-[12px] font-medium text-[var(--kn-text)] transition-colors hover:bg-[var(--kn-active)]">
                      <RotateCcw className="size-3.5" /> Rouvrir
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ color: SEVERITY_COLOR[severity], background: `${SEVERITY_COLOR[severity]}1f` }}>
      <AlertTriangle className="size-3" /> {SEVERITY_LABEL[severity]}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--kn-border)] py-16 text-center text-[var(--kn-text-muted)]">
      <CheckCircle2 className="size-8 text-[#16a34a]" strokeWidth={1.5} />
      <p className="text-[14px] font-medium text-[var(--kn-text)]">Aucune anomalie ouverte</p>
      <p className="text-[12px]">Toutes les factures du portefeuille sont cohérentes.</p>
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

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-4">
      <h3 className="text-[14px] font-semibold text-[var(--kn-text)]">{title}</h3>
      <p className="mb-3 text-[12px] text-[var(--kn-text-muted)]">{subtitle}</p>
      {children}
    </div>
  );
}
