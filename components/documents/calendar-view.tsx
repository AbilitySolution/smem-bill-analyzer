"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CalendarDays, Hash, Euro } from "lucide-react";
import type { InvoiceDoc } from "@/lib/data/invoices";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");
const eurShort = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 0 }) + " €";
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const frLong = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  const mois = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  return `${d} ${mois[m - 1]} ${y}`;
};
const plural = (n: number) => (n > 1 ? "factures" : "facture");

export type PeriodFilter = { from: string; to: string; label: string };

type Gran = "calendrier" | "trimestre" | "semestre";

const GRANS: { id: Gran; label: string }[] = [
  { id: "calendrier", label: "Calendrier" },
  { id: "trimestre", label: "Trimestre" },
  { id: "semestre", label: "Semestre" },
];

const WEEKDAYS = ["L", "M", "M", "J", "V", "S", "D"];
const MONTHS = ["Jan", "Fév", "Mar", "Avr", "Mai", "Juin", "Juil", "Août", "Sep", "Oct", "Nov", "Déc"];

/** Échelle de couleur (orange) selon le nb de factures d'un jour rapporté au max de l'année. */
function levelColor(n: number, max: number): string {
  if (n <= 0) return "var(--kn-panel)";
  const t = max <= 1 ? 1 : n / max;
  if (t <= 0.25) return "#fed7aa"; // orange-200
  if (t <= 0.5) return "#fdba74"; // orange-300
  if (t <= 0.75) return "#fb923c"; // orange-400
  return "#f97316"; // orange-500
}

export function CalendarView({ docs, onPick }: { docs: InvoiceDoc[]; onPick: (p: PeriodFilter) => void }) {
  const years = useMemo(() => {
    const set = new Set<number>();
    for (const d of docs) {
      const y = Number(d.date.slice(0, 4));
      if (!Number.isNaN(y)) set.add(y);
    }
    return [...set].sort((a, b) => a - b);
  }, [docs]);

  const [gran, setGran] = useState<Gran>("calendrier");
  const [year, setYear] = useState<number>(() => (years.length ? years[years.length - 1] : new Date().getFullYear()));

  // Comptage par jour "YYYY-MM-DD" -> { count, ttc } (année sélectionnée)
  const byDay = useMemo(() => {
    const map = new Map<string, { count: number; ttc: number }>();
    for (const d of docs) {
      if (Number(d.date.slice(0, 4)) !== year) continue;
      const cur = map.get(d.date) ?? { count: 0, ttc: 0 };
      cur.count += 1;
      cur.ttc += d.totalTtc;
      map.set(d.date, cur);
    }
    return map;
  }, [docs, year]);

  const yearTotal = useMemo(() => {
    let count = 0, ttc = 0;
    for (const v of byDay.values()) { count += v.count; ttc += v.ttc; }
    return { count, ttc };
  }, [byDay]);

  const canPrev = years.length ? year > years[0] : false;
  const canNext = years.length ? year < years[years.length - 1] : false;

  return (
    <div className="rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-5">
      {/* Barre : année + granularité + total */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <button
            onClick={() => canPrev && setYear((y) => y - 1)}
            disabled={!canPrev}
            aria-label="Année précédente"
            className="rounded-md p-1.5 text-[var(--kn-text-muted)] enabled:hover:bg-[var(--kn-active)] disabled:opacity-30"
          >
            <ChevronLeft className="size-4" />
          </button>
          <span className="min-w-[3.5rem] text-center text-[15px] font-bold tabular-nums text-[var(--kn-text)]">{year}</span>
          <button
            onClick={() => canNext && setYear((y) => y + 1)}
            disabled={!canNext}
            aria-label="Année suivante"
            className="rounded-md p-1.5 text-[var(--kn-text-muted)] enabled:hover:bg-[var(--kn-active)] disabled:opacity-30"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>

        <div className="flex items-center gap-0.5 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-panel)] p-0.5">
          {GRANS.map((g) => (
            <button
              key={g.id}
              onClick={() => setGran(g.id)}
              className={cx(
                "rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors",
                gran === g.id ? "bg-[#f97316] text-white" : "text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)]",
              )}
            >
              {g.label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-4 text-[12px] text-[var(--kn-text-muted)]">
          <span className="inline-flex items-center gap-1.5"><Hash className="size-3.5" /><b className="tabular-nums text-[var(--kn-text)]">{yearTotal.count}</b> {plural(yearTotal.count)}</span>
          <span className="inline-flex items-center gap-1.5"><Euro className="size-3.5" /><b className="tabular-nums text-[var(--kn-text)]">{eurShort(yearTotal.ttc)}</b></span>
        </div>
      </div>

      {years.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-[var(--kn-text-muted)]">
          <CalendarDays className="size-8" strokeWidth={1.4} />
          <p className="text-[13px]">Aucune date de facture à afficher.</p>
        </div>
      ) : gran === "calendrier" ? (
        <Heatmap year={year} byDay={byDay} onPick={onPick} />
      ) : (
        <PeriodCards gran={gran} year={year} byDay={byDay} onPick={onPick} />
      )}
    </div>
  );
}

/** Heatmap annuelle « façon contributions » : une colonne par semaine (lundi en haut). */
function Heatmap({
  year,
  byDay,
  onPick,
}: {
  year: number;
  byDay: Map<string, { count: number; ttc: number }>;
  onPick: (p: PeriodFilter) => void;
}) {
  const { weeks, monthLabels, max } = useMemo(() => {
    type Cell = { date: string; count: number; ttc: number } | null;
    const cells: Cell[] = [];
    // Décalage de tête : jour de semaine du 1er janvier (lundi=0 … dimanche=6)
    const lead = (new Date(year, 0, 1).getDay() + 6) % 7;
    for (let i = 0; i < lead; i++) cells.push(null);

    let max = 0;
    const daysInMonth = (m: number) => new Date(year, m, 0).getDate();
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= daysInMonth(m); d++) {
        const key = iso(year, m, d);
        const v = byDay.get(key) ?? { count: 0, ttc: 0 };
        if (v.count > max) max = v.count;
        cells.push({ date: key, count: v.count, ttc: v.ttc });
      }
    }
    while (cells.length % 7 !== 0) cells.push(null);

    const weeks: Cell[][] = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

    // Étiquettes de mois : placées sur la 1re semaine contenant le 1er du mois
    const monthLabels: { col: number; label: string }[] = [];
    let seen = -1;
    weeks.forEach((w, col) => {
      const first = w.find((c): c is NonNullable<Cell> => !!c);
      if (!first) return;
      const mo = Number(first.date.slice(5, 7)) - 1;
      if (mo !== seen) { monthLabels.push({ col, label: MONTHS[mo] }); seen = mo; }
    });

    return { weeks, monthLabels, max };
  }, [year, byDay]);

  const CELL = 13; // px
  const GAP = 3; // px
  const STEP = CELL + GAP;

  return (
    <div className="overflow-x-auto pb-1">
      <div className="inline-block">
        {/* Étiquettes de mois */}
        <div className="relative mb-1 ml-6 h-4" style={{ width: weeks.length * STEP }}>
          {monthLabels.map((m) => (
            <span
              key={`${m.col}-${m.label}`}
              className="absolute top-0 text-[10px] font-medium text-[var(--kn-text-muted)]"
              style={{ left: m.col * STEP }}
            >
              {m.label}
            </span>
          ))}
        </div>

        <div className="flex gap-[3px]">
          {/* Étiquettes de jours (L .. D) */}
          <div className="mr-1 flex flex-col gap-[3px]" style={{ width: 16 }}>
            {WEEKDAYS.map((w, i) => (
              <span key={i} className="text-[9px] leading-none text-[var(--kn-text-muted)]" style={{ height: CELL, lineHeight: `${CELL}px` }}>
                {i % 2 === 0 ? w : ""}
              </span>
            ))}
          </div>

          {/* Colonnes = semaines */}
          {weeks.map((w, ci) => (
            <div key={ci} className="flex flex-col gap-[3px]">
              {w.map((cell, ri) =>
                cell ? (
                  <button
                    key={cell.date}
                    onClick={() => onPick({ from: cell.date, to: cell.date, label: frLong(cell.date) })}
                    title={`${frLong(cell.date)} · ${cell.count} ${plural(cell.count)}${cell.count ? ` · ${eurShort(cell.ttc)}` : ""}`}
                    className="rounded-[3px] ring-offset-1 transition-transform hover:scale-110 hover:ring-1 hover:ring-[#ea580c] focus:outline-none focus:ring-1 focus:ring-[#ea580c]"
                    style={{ width: CELL, height: CELL, backgroundColor: levelColor(cell.count, max) }}
                  />
                ) : (
                  <span key={`e-${ci}-${ri}`} style={{ width: CELL, height: CELL }} />
                ),
              )}
            </div>
          ))}
        </div>

        {/* Légende */}
        <div className="mt-3 ml-6 flex items-center gap-1.5 text-[10px] text-[var(--kn-text-muted)]">
          <span>Moins</span>
          {[0, 0.2, 0.45, 0.7, 1].map((t, i) => (
            <span key={i} className="rounded-[3px]" style={{ width: CELL, height: CELL, backgroundColor: levelColor(t === 0 ? 0 : Math.ceil(t * (max || 1)), max || 1) }} />
          ))}
          <span>Plus</span>
        </div>
      </div>
    </div>
  );
}

/** Cartes par trimestre (T1–T4) ou semestre (S1/S2), cliquables pour filtrer la liste. */
function PeriodCards({
  gran,
  year,
  byDay,
  onPick,
}: {
  gran: "trimestre" | "semestre";
  year: number;
  byDay: Map<string, { count: number; ttc: number }>;
  onPick: (p: PeriodFilter) => void;
}) {
  const buckets =
    gran === "trimestre"
      ? [
          { label: "T1", sub: "Jan – Mar", m0: 1, m1: 3 },
          { label: "T2", sub: "Avr – Juin", m0: 4, m1: 6 },
          { label: "T3", sub: "Juil – Sep", m0: 7, m1: 9 },
          { label: "T4", sub: "Oct – Déc", m0: 10, m1: 12 },
        ]
      : [
          { label: "S1", sub: "Jan – Juin", m0: 1, m1: 6 },
          { label: "S2", sub: "Juil – Déc", m0: 7, m1: 12 },
        ];

  const stats = buckets.map((b) => {
    let count = 0, ttc = 0;
    for (const [date, v] of byDay) {
      const mo = Number(date.slice(5, 7));
      if (mo >= b.m0 && mo <= b.m1) { count += v.count; ttc += v.ttc; }
    }
    const lastDay = new Date(year, b.m1, 0).getDate();
    return { ...b, count, ttc, from: iso(year, b.m0, 1), to: iso(year, b.m1, lastDay) };
  });

  const maxCount = Math.max(1, ...stats.map((s) => s.count));

  return (
    <div className={cx("grid gap-3", gran === "trimestre" ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-1 sm:grid-cols-2")}>
      {stats.map((s) => (
        <button
          key={s.label}
          onClick={() => onPick({ from: s.from, to: s.to, label: `${s.label} ${year}` })}
          className="group flex flex-col gap-3 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-panel)] p-4 text-left transition-colors hover:border-[#f97316] hover:bg-[var(--kn-yellow-soft)]"
        >
          <div className="flex items-baseline justify-between">
            <span className="text-[15px] font-bold text-[var(--kn-text)]">{s.label}</span>
            <span className="text-[11px] text-[var(--kn-text-muted)]">{s.sub}</span>
          </div>
          <div>
            <p className="text-[26px] font-bold leading-none tabular-nums text-[var(--kn-text)]">{s.count}</p>
            <p className="mt-1 text-[11px] uppercase tracking-wide text-[var(--kn-text-muted)]">{plural(s.count)}</p>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--kn-value-box)]">
            <div className="h-full rounded-full bg-[#f97316]" style={{ width: `${(s.count / maxCount) * 100}%` }} />
          </div>
          <span className="text-[12px] font-medium tabular-nums text-[var(--kn-text-muted)]">{eurShort(s.ttc)}</span>
        </button>
      ))}
    </div>
  );
}
