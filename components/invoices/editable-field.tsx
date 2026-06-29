"use client";

import { useState, useTransition } from "react";
import { Pencil, Check, X } from "lucide-react";
import { updateInvoiceField } from "@/app/(app)/factures/[id]/actions";

export function EditableField({
  invoiceId,
  field,
  label,
  value,
  display,
  type = "text",
}: {
  invoiceId: string;
  field: string;
  label: string;
  value: string | number | null;
  display: string;
  type?: "text" | "number" | "date";
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value ?? ""));
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      await updateInvoiceField(invoiceId, field, value != null ? String(value) : null, draft);
      setEditing(false);
    });
  }

  return (
    <div className="group flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-[#ffedd5]">
      <span className="text-xs font-medium text-[#585e74]">{label}</span>
      {editing ? (
        <div className="flex items-center gap-1">
          <input
            autoFocus
            type={type}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") setEditing(false);
            }}
            className="h-7 w-32 rounded-md border border-[#1a1a1a]/25 px-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#f97316]"
          />
          <button onClick={save} disabled={pending} className="text-[#0f6e56] hover:text-[#0c5644]">
            <Check className="size-3.5" />
          </button>
          <button onClick={() => setEditing(false)} className="text-slate-400 hover:text-slate-600">
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <button
          onClick={() => {
            setDraft(String(value ?? ""));
            setEditing(true);
          }}
          className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-sm font-medium text-[#1a1a1a] group-hover:bg-[#fb923c]"
        >
          {display}
          <Pencil className="size-3 text-[#1a1a1a]/30 opacity-0 group-hover:opacity-100" />
        </button>
      )}
    </div>
  );
}
