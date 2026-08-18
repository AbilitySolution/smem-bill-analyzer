"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, ShieldAlert, MapPin, CheckCircle2, Info, ExternalLink, RotateCcw, History, Euro,
  ChevronDown, Gauge, Receipt, Tag, HelpCircle,
} from "lucide-react";
import type { InvoiceDoc } from "@/lib/data/invoices";
import type { AnomalyContext } from "@/lib/data/anomaly-context";
import {
  SEVERITY_LABEL, SEVERITY_COLOR, SECTION_META, SECTION_ORDER, sectionOf, typeLabel,
  type AnomalySection, type Severity,
} from "@/lib/data/anomalies";
import { setAnomalyResolved } from "@/app/(app)/anomalies/actions";
import { Sparkline } from "./sparkline";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");
const eur = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 0 }) + " €";
const SEV_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

const SECTION_ICON: Record<AnomalySection, typeof Gauge> = {
  consommation: Gauge,
  tarif: Tag,
  facturation: Receipt,
  autres: HelpCircle,
};

interface FeedItem {
  id: string;
  invoiceId: string;
  number: string;
  site: string;
  commune: string;
  section: AnomalySection;
  severity: Severity;
  message: string;
  type: string;
  valueEur?: number;
  resolved: boolean;
}

export function AnomaliesView({ docs, context, focus }: {
  docs: InvoiceDoc[];
  /** Historique de consommation par site : sparklines et taux d'anomalie. Null si indisponible. */
  context?: AnomalyContext | null;
  focus?: string;
}) {
  // Surcharge optimiste locale (id -> resolved) le temps que la server action écrive en
  // DB et que la page se revalide — la vérité reste toujours la DB.
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const [commune, setCommune] = useState("");
  const [site, setSite] = useState("");
  const [collapsed, setCollapsed] = useState<Set<AnomalySection>>(new Set());

  const allItems: FeedItem[] = useMemo(() => {
    const items: FeedItem[] = [];
    for (const d of docs) {
      for (const a of d.anomalies ?? []) {
        items.push({
          id: a.id, invoiceId: d.id, number: d.number, site: d.site, commune: d.commune,
          section: sectionOf(a.type), severity: a.severity, message: a.message, type: a.type,
          valueEur: a.valueEur, resolved: overrides.get(a.id) ?? a.resolved,
        });
      }
    }
    return items;
  }, [docs, overrides]);

  const open = useMemo(
    () => allItems.filter((i) => !i.resolved).sort((a, b) => {
      const aFocus = a.invoiceId === focus;
      const bFocus = b.invoiceId === focus;
      if (aFocus !== bFocus) return aFocus ? -1 : 1;
      return SEV_RANK[a.severity] - SEV_RANK[b.severity];
    }),
    [allItems, focus],
  );

  // Les options de filtre sont calculées sur l'ensemble ouvert, AVANT filtrage : une liste
  // d'options qui se vide au fur et à mesure qu'on filtre interdit de revenir en arrière
  // sans tout réinitialiser. Seuls les sites se restreignent à la commune choisie.
  const communeOptions = useMemo(
    () => [...new Set(open.map((i) => i.commune))].sort((a, b) => a.localeCompare(b, "fr")),
    [open],
  );
  const siteOptions = useMemo(
    () => [...new Set(open.filter((i) => !commune || i.commune === commune).map((i) => i.site))]
      .sort((a, b) => a.localeCompare(b, "fr")),
    [open, commune],
  );

  const filtered = useMemo(
    () => open.filter((i) => (!commune || i.commune === commune) && (!site || i.site === site)),
    [open, commune, site],
  );

  const history = useMemo(() => allItems.filter((i) => i.resolved), [allItems]);

  const bySection = useMemo(() => {
    const map = new Map<AnomalySection, FeedItem[]>();
    for (const it of filtered) {
      const arr = map.get(it.section) ?? [];
      arr.push(it);
      map.set(it.section, arr);
    }
    return map;
  }, [filtered]);

  // Classement par TAUX et non par nombre : en valeur absolue, le site qui porte la moitié
  // du portefeuille arrive toujours premier et l'attention se porte toujours au même
  // endroit. Le taux fait remonter un petit site réellement en difficulté.
  const siteRanking = useMemo(() => {
    if (!context) return [];
    const counts = new Map<string, { site: string; commune: string; anomalies: number; invoices: number }>();
    for (const it of filtered) {
      const siteId = context.siteByInvoice[it.invoiceId];
      if (!siteId) continue;
      const row = counts.get(siteId) ?? {
        site: it.site, commune: it.commune, anomalies: 0,
        invoices: context.invoiceCountBySite[siteId] ?? 0,
      };
      row.anomalies += 1;
      counts.set(siteId, row);
    }
    return [...counts.values()]
      .filter((r) => r.invoices > 0)
      .map((r) => ({ ...r, rate: r.anomalies / r.invoices }))
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 8);
  }, [context, filtered]);

  const sitesTouched = new Set(filtered.map((i) => i.site)).size;
  const highCount = filtered.filter((i) => i.severity === "high").length;
  const valueFound = filtered.reduce((s, i) => s + Math.abs(i.valueEur ?? 0), 0);
  const hasFilter = Boolean(commune || site);

  function resolve(id: string) {
    setOverrides((prev) => new Map(prev).set(id, true));
    void setAnomalyResolved(id, true);
  }
  function reopen(id: string) {
    setOverrides((prev) => new Map(prev).set(id, false));
    void setAnomalyResolved(id, false);
  }
  function toggleSection(s: AnomalySection) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  }

  const visibleSections = SECTION_ORDER.filter((s) => (bySection.get(s)?.length ?? 0) > 0);

  return (
    <div className="mx-auto max-w-5xl px-8 py-6">
      <div className="mb-1 flex items-center gap-2.5">
        <AlertTriangle className="size-6 text-[#f59e0b]" strokeWidth={1.9} />
        <h1 className="font-heading text-2xl font-bold text-[var(--kn-text)]">Anomalies</h1>
        <span className="rounded-full bg-[var(--kn-yellow-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#9a3412]">Version bêta</span>
      </div>

      <div className="mb-5 mt-3 flex items-start gap-2.5 rounded-xl border border-[#fed7aa] bg-[var(--kn-yellow-soft)] px-4 py-3">
        <Info className="mt-0.5 size-4 shrink-0 text-[#ea580c]" />
        <p className="text-[13px] text-[var(--kn-text)]">
          Les alertes sont classées par <strong>action à mener</strong> plutôt que par nature technique.
          L&apos;écart de consommation se mesure en nombre de variations habituelles du site, et non en pourcentage fixe :
          un site régulier et un site erratique ne sont pas jugés à la même aune.
          Suivi partagé entre les membres de l&apos;organisation.
        </p>
      </div>

      {open.length === 0 && history.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {open.length > 0 && (
            <>
              <div className="mb-5 flex flex-wrap items-end gap-3 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-panel)] p-3">
                <FilterSelect label="Commune" value={commune}
                  onChange={(v) => { setCommune(v); setSite(""); }}
                  options={[{ value: "", label: "Toutes les communes" }, ...communeOptions.map((c) => ({ value: c, label: c }))]} />
                <FilterSelect label="Site" value={site} onChange={setSite}
                  options={[{ value: "", label: "Tous les sites" }, ...siteOptions.map((s) => ({ value: s, label: s }))]} />
                {hasFilter && (
                  <button onClick={() => { setCommune(""); setSite(""); }}
                    className="h-9 rounded-lg border border-[var(--kn-border)] px-3 text-[12px] font-medium text-[var(--kn-text-muted)] transition-colors hover:bg-[var(--kn-active)]">
                    Réinitialiser
                  </button>
                )}
                <span className="ml-auto self-center text-[12px] text-[var(--kn-text-muted)]">
                  {filtered.length} alerte{filtered.length > 1 ? "s" : ""} ouverte{filtered.length > 1 ? "s" : ""}
                  {hasFilter && ` sur ${open.length}`}
                </span>
              </div>

              {valueFound > 0 && (
                <div className="mb-5 flex items-center gap-4 rounded-xl border border-[#fed7aa] bg-gradient-to-br from-[var(--kn-yellow-soft)] to-transparent px-5 py-4">
                  <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-[#f97316] text-white">
                    <Euro className="size-6" />
                  </span>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[#9a3412]">Valeur détectée</p>
                    <p className="font-heading text-2xl font-bold tabular-nums text-[var(--kn-text)]">{eur(valueFound)}</p>
                    <p className="text-[12px] text-[var(--kn-text-muted)]">Écarts de totaux et surcoûts au kWh, cumulés sur les alertes affichées.</p>
                  </div>
                </div>
              )}

              <div className="mb-5 grid grid-cols-3 gap-3">
                <Kpi icon={<AlertTriangle className="size-4" />} label="Alertes ouvertes" value={String(filtered.length)} />
                <Kpi icon={<MapPin className="size-4" />} label="Sites touchés" value={String(sitesTouched)} />
                <Kpi icon={<ShieldAlert className="size-4" />} label="Élevées" value={String(highCount)} />
              </div>

              {siteRanking.length > 1 && <SiteRanking rows={siteRanking} />}

              <div className="space-y-4">
                {visibleSections.map((s) => {
                  const items = bySection.get(s) ?? [];
                  const isOpen = !collapsed.has(s);
                  const Icon = SECTION_ICON[s];
                  const high = items.filter((i) => i.severity === "high").length;
                  return (
                    <section key={s} className="rounded-xl border border-[var(--kn-border)] bg-[var(--kn-panel)]">
                      <button onClick={() => toggleSection(s)} aria-expanded={isOpen}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left">
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--kn-yellow-soft)] text-[#ea580c]">
                          <Icon className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-[14px] font-semibold text-[var(--kn-text)]">{SECTION_META[s].label}</span>
                            <span className="rounded-full bg-[var(--kn-value-box)] px-2 py-0.5 text-[11px] font-medium tabular-nums text-[var(--kn-text-muted)]">{items.length}</span>
                            {high > 0 && (
                              <span className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                                style={{ color: SEVERITY_COLOR.high, background: `${SEVERITY_COLOR.high}1f` }}>
                                {high} élevée{high > 1 ? "s" : ""}
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block text-[12px] text-[var(--kn-text-muted)]">{SECTION_META[s].hint}</span>
                        </span>
                        <ChevronDown className={cx("size-4 shrink-0 text-[var(--kn-text-muted)] transition-transform", !isOpen && "-rotate-90")} />
                      </button>

                      {isOpen && (
                        <div className="space-y-2 px-3 pb-3">
                          {items.map((it) => (
                            <AlertCard key={it.id} item={it} context={context} focus={focus} onResolve={resolve} />
                          ))}
                        </div>
                      )}
                    </section>
                  );
                })}
                {visibleSections.length === 0 && (
                  <p className="py-8 text-center text-[13px] text-[var(--kn-text-muted)]">Aucune alerte ouverte pour ces filtres.</p>
                )}
              </div>
            </>
          )}

          {history.length > 0 && (
            <div className="mt-8">
              <h2 className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-[var(--kn-text)]">
                <History className="size-4 text-[var(--kn-text-muted)]" /> Historique des résolutions
                <span className="rounded-full bg-[var(--kn-value-box)] px-2 py-0.5 text-[11px] text-[var(--kn-text-muted)]">{history.length}</span>
              </h2>
              <div className="space-y-2">
                {history.map((it) => (
                  <div key={it.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-panel)] p-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full bg-[#dcfce7] px-2 py-0.5 text-[11px] font-medium text-[#15803d]">
                        <CheckCircle2 className="size-3" /> Résolue
                      </span>
                      <div className="min-w-0">
                        <p className="text-[13px] text-[var(--kn-text-muted)] line-through">{it.message}</p>
                        <span className="text-[12px] text-[var(--kn-text-muted)]">{it.number} · {it.site} · {it.commune}</span>
                      </div>
                    </div>
                    <button onClick={() => reopen(it.id)}
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

function AlertCard({ item, context, focus, onResolve }: {
  item: FeedItem;
  context?: AnomalyContext | null;
  focus?: string;
  onResolve: (id: string) => void;
}) {
  const siteId = context?.siteByInvoice[item.invoiceId];
  const series = siteId ? context?.seriesBySite[siteId] : undefined;
  // La sparkline n'a de sens que là où l'alerte porte sur la consommation : sur un total
  // TTC incohérent, l'historique kWh du site n'explique rien et n'ajoute que du bruit.
  const showSpark = item.section === "consommation" && series && series.points.length >= 2;

  return (
    <div className={cx(
      "flex items-center justify-between gap-3 rounded-xl border bg-[var(--kn-card)] p-3 transition-all",
      item.invoiceId === focus ? "border-[#f97316] shadow-md" : "border-[var(--kn-border)]",
    )}>
      <div className="flex min-w-0 items-start gap-3">
        <SeverityBadge severity={item.severity} />
        <div className="min-w-0">
          <p className="text-[13px] text-[var(--kn-text)]">
            <span className="mr-1.5 rounded bg-[var(--kn-value-box)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--kn-text-muted)]">
              {typeLabel(item.type)}
            </span>
            {item.message}
            {item.valueEur != null && Math.abs(item.valueEur) >= 1 && (
              <span className="ml-1.5 font-semibold text-[#ea580c]">({eur(Math.abs(item.valueEur))})</span>
            )}
          </p>
          <Link href={`/documents/extraction?id=${item.invoiceId}`}
            className="mt-0.5 inline-flex items-center gap-1 text-[12px] text-[var(--kn-text-muted)] hover:text-[#ea580c]">
            {item.number} · {item.site} · {item.commune} <ExternalLink className="size-3" />
          </Link>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {showSpark && series && (
          <span className="hidden sm:block"
            title={`Historique du site : ${series.points.length} factures. Bande = variation habituelle, point coloré = cette facture.`}>
            <Sparkline points={series.points} highlightInvoiceId={item.invoiceId}
              baseline={series.baseline} band={series.band} severity={item.severity} />
          </span>
        )}
        <button onClick={() => onResolve(item.id)}
          className="rounded-lg border border-[var(--kn-border)] px-3 py-1.5 text-[12px] font-medium text-[var(--kn-text)] transition-colors hover:bg-[var(--kn-active)]">
          Marquer résolue
        </button>
      </div>
    </div>
  );
}

function SiteRanking({ rows }: {
  rows: { site: string; commune: string; anomalies: number; invoices: number; rate: number }[];
}) {
  const max = Math.max(...rows.map((r) => r.rate), 0.0001);
  return (
    <div className="mb-5 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-4">
      <h3 className="text-[14px] font-semibold text-[var(--kn-text)]">Sites les plus touchés</h3>
      <p className="mb-3 text-[12px] text-[var(--kn-text-muted)]">
        Part des factures du site portant une alerte — et non nombre brut, qui ferait toujours ressortir les sites les plus documentés.
      </p>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={`${r.commune}/${r.site}`} className="flex items-center gap-3">
            <span className="w-40 shrink-0 truncate text-[12px] text-[var(--kn-text)]" title={`${r.site} · ${r.commune}`}>{r.site}</span>
            <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-[var(--kn-value-box)]">
              <span className="block h-full rounded-full bg-[#f97316]" style={{ width: `${Math.max(3, (r.rate / max) * 100)}%` }} />
            </span>
            <span className="w-24 shrink-0 text-right text-[12px] tabular-nums text-[var(--kn-text-muted)]">
              {Math.round(r.rate * 100)}% · {r.anomalies}/{r.invoices}
            </span>
          </div>
        ))}
      </div>
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

function FilterSelect({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-[var(--kn-text-muted)]">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="h-9 max-w-56 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2.5 text-[13px] text-[var(--kn-text)] focus:border-[var(--kn-text)] focus:outline-none">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
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
