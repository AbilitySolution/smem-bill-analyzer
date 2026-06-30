"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Check, X } from "lucide-react";
import { updateExtractionField } from "@/app/(app)/factures/[id]/actions";

export type FieldKind = "text" | "number" | "date" | "select" | "boolean";

export interface EditFieldProps {
  invoiceId: string;
  table: string;
  rowId: string;
  field: string;
  label: string;
  value: string | number | boolean | null;
  kind?: FieldKind;
  options?: { value: string; label: string }[];
  precision?: number;
  /** masque la colonne précision (ex. lignes de tableau) */
  compact?: boolean;
}

function fmtDisplay(kind: FieldKind, value: string | number | boolean | null, options?: { value: string; label: string }[]) {
  if (value === null || value === "") return "—";
  if (kind === "boolean") return value === true || value === "true" ? "Oui" : "Non";
  if (kind === "select") return options?.find((o) => o.value === String(value))?.label ?? String(value);
  return String(value);
}

export function EditField({ invoiceId, table, rowId, field, label, value, kind = "text", options, precision, compact }: EditFieldProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [display, setDisplay] = useState(() => fmtDisplay(kind, value, options));
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  const [pending, startTransition] = useTransition();

  function save(nextRaw?: string) {
    const raw = nextRaw ?? draft;
    startTransition(async () => {
      const res = await updateExtractionField(invoiceId, table, rowId, field, value == null ? null : String(value), raw);
      if (!res.error) {
        setDisplay(fmtDisplay(kind, raw, options));
        setEditing(false);
        router.refresh();
      }
    });
  }

  return (
    <div className="group flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-[#ffedd5]">
      <span className="text-[12px] font-medium text-[var(--kn-text-muted)]">{label}</span>
      <div className="flex items-center gap-2">
        {editing ? (
          <div className="flex items-center gap-1">
            {kind === "select" ? (
              <select autoFocus value={draft} onChange={(e) => { setDraft(e.target.value); save(e.target.value); }}
                className="h-7 rounded-md border border-[var(--kn-text)]/25 px-1 text-sm focus:outline-none focus:ring-2 focus:ring-[#f97316]">
                <option value="">—</option>
                {options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : kind === "boolean" ? (
              <select autoFocus value={draft} onChange={(e) => { setDraft(e.target.value); save(e.target.value); }}
                className="h-7 rounded-md border border-[var(--kn-text)]/25 px-1 text-sm focus:outline-none focus:ring-2 focus:ring-[#f97316]">
                <option value="true">Oui</option>
                <option value="false">Non</option>
              </select>
            ) : (
              <input autoFocus type={kind === "number" ? "number" : kind === "date" ? "date" : "text"}
                value={draft} onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
                className="h-7 w-36 rounded-md border border-[var(--kn-text)]/25 px-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#f97316]" />
            )}
            {kind !== "select" && kind !== "boolean" && (
              <button onClick={() => save()} disabled={pending} className="text-[#0f6e56] hover:text-[#0c5644]"><Check className="size-3.5" /></button>
            )}
            <button onClick={() => setEditing(false)} className="text-slate-400 hover:text-slate-600"><X className="size-3.5" /></button>
          </div>
        ) : (
          <button onClick={() => { setDraft(value == null ? "" : String(value)); setEditing(true); }}
            className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-sm font-medium text-[var(--kn-text)] group-hover:bg-[#fb923c]">
            {display}
            <Pencil className="size-3 text-[var(--kn-text)]/30 opacity-0 group-hover:opacity-100" />
          </button>
        )}
        {!compact && (
          <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-[var(--kn-text-muted)]">
            {precision != null ? `${Math.round(precision * 100)}%` : "—"}
          </span>
        )}
      </div>
    </div>
  );
}
