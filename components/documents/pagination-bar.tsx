"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { PAGE_SIZES } from "@/lib/data/invoice-list-params";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");
const nf = (n: number) => n.toLocaleString("fr-FR");

/**
 * Fenêtre de pages autour de la page courante, avec ellipses.
 * Toujours 1 et la dernière, pour garder « aller au début / à la fin » à un clic.
 */
function pageWindow(current: number, count: number): (number | "…")[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const out: (number | "…")[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(count - 1, current + 1);
  if (start > 2) out.push("…");
  for (let p = start; p <= end; p++) out.push(p);
  if (end < count - 1) out.push("…");
  out.push(count);
  return out;
}

export function PaginationBar({
  page, pageCount, pageSize, total, pending, onPage, onPageSize,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  pending?: boolean;
  onPage: (p: number) => void;
  onPageSize: (s: number) => void;
}) {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  const btn = "flex size-8 items-center justify-center rounded-lg border border-[var(--kn-border)] text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className={cx("flex flex-wrap items-center gap-3 border-t border-[var(--kn-border)] bg-[var(--kn-card)] px-4 py-2.5", pending && "opacity-60")}>
      {/* Repère de position : indispensable pour ne pas naviguer à l'aveugle */}
      <p className="text-[12px] tabular-nums text-[var(--kn-text-muted)]" aria-live="polite">
        {total === 0 ? "Aucune facture" : <>{nf(first)}–{nf(last)} sur <strong className="font-semibold text-[var(--kn-text)]">{nf(total)}</strong></>}
      </p>

      <label className="flex items-center gap-1.5 text-[12px] text-[var(--kn-text-muted)]">
        <span className="hidden sm:inline">Par page</span>
        <select
          value={pageSize}
          onChange={(e) => onPageSize(Number(e.target.value))}
          className="h-8 cursor-pointer rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2 text-[12px] font-medium text-[var(--kn-text)] focus:border-[#f97316] focus:outline-none"
        >
          {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>

      <nav className="ml-auto flex items-center gap-1" aria-label="Pagination">
        <button
          type="button" onClick={() => onPage(page - 1)} disabled={page <= 1}
          aria-label="Page précédente"
          className={cx(btn, "cursor-pointer text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]")}
        >
          <ChevronLeft className="size-4" />
        </button>

        {pageWindow(page, pageCount).map((p, i) =>
          p === "…" ? (
            <span key={`gap-${i}`} className="px-1 text-[13px] text-[var(--kn-text-muted)]">…</span>
          ) : (
            <button
              key={p} type="button" onClick={() => onPage(p)}
              aria-current={p === page ? "page" : undefined}
              className={cx(btn, "cursor-pointer tabular-nums",
                p === page
                  ? "border-[#f97316] bg-[#f97316] text-white"
                  : "text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]")}
            >
              {p}
            </button>
          ),
        )}

        <button
          type="button" onClick={() => onPage(page + 1)} disabled={page >= pageCount}
          aria-label="Page suivante"
          className={cx(btn, "cursor-pointer text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]")}
        >
          <ChevronRight className="size-4" />
        </button>
      </nav>
    </div>
  );
}
