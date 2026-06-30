"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, ChevronDown, FileText, Check, MapPin, Building2, Lightbulb } from "lucide-react";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");
const frDate = (d: string) => { const [y, m, j] = d.split("-"); return `${j}/${m}/${y}`; };

export interface PickerInvoice {
  id: string;
  number: string;
  site: string;
  commune: string;
  categorie: "batiment" | "eclairage_public";
  date: string;
  isDuplicata: boolean;
}

/** Sélecteur de facture (au-dessus du visualiseur) : recherche + filtres commune / site / date. */
export function InvoicePicker({ invoices, currentId }: { invoices: PickerInvoice[]; currentId?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [commune, setCommune] = useState("");
  const [site, setSite] = useState("");
  const [year, setYear] = useState("");

  const current = invoices.find((i) => i.id === currentId) ?? null;

  const communes = useMemo(() => [...new Set(invoices.map((i) => i.commune))].sort(), [invoices]);
  const sites = useMemo(() => [...new Set(invoices.filter((i) => !commune || i.commune === commune).map((i) => i.site))].sort(), [invoices, commune]);
  const years = useMemo(() => [...new Set(invoices.map((i) => i.date.slice(0, 4)))].sort().reverse(), [invoices]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return invoices.filter((i) =>
      (!commune || i.commune === commune) &&
      (!site || i.site === site) &&
      (!year || i.date.startsWith(year)) &&
      (i.number.toLowerCase().includes(q) || i.site.toLowerCase().includes(q) || i.commune.toLowerCase().includes(q)),
    );
  }, [invoices, query, commune, site, year]);

  function pick(id: string) { setOpen(false); router.push(`/documents/extraction?id=${id}`); }

  return (
    <div className="relative shrink-0">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-3 py-2 text-left text-[13px] transition-colors hover:border-[#fb923c]"
        >
          <FileText className="size-4 shrink-0 text-[#ea580c]" />
          {current ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="font-semibold text-[var(--kn-text)]">{current.number}</span>
              <span className="truncate text-[var(--kn-text-muted)]">· {current.site} · {current.commune}</span>
            </span>
          ) : (
            <span className="text-[var(--kn-text-muted)]">Choisir une facture à étudier…</span>
          )}
          <ChevronDown className={cx("ml-auto size-4 shrink-0 text-[var(--kn-text-muted)] transition-transform", open && "rotate-180")} />
        </button>
      </div>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 top-full z-40 mt-1.5 overflow-hidden rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] shadow-xl">
            {/* Filtres */}
            <div className="space-y-2 border-b border-[var(--kn-border)] p-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--kn-text-muted)]" />
                <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher une facture"
                  className="h-9 w-full rounded-lg border border-[var(--kn-border)] pl-9 pr-3 text-sm focus:border-[#f97316] focus:outline-none" />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Sel value={commune} onChange={(v) => { setCommune(v); setSite(""); }} icon={<MapPin className="size-3.5" />} placeholder="Commune" options={communes} />
                <Sel value={site} onChange={setSite} icon={<Building2 className="size-3.5" />} placeholder="Site" options={sites} />
                <Sel value={year} onChange={setYear} icon={<Lightbulb className="size-3.5" />} placeholder="Année" options={years} />
              </div>
            </div>
            {/* Liste */}
            <div className="max-h-72 overflow-y-auto py-1">
              {filtered.map((i) => (
                <button key={i.id} onClick={() => pick(i.id)}
                  className={cx("flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-[var(--kn-yellow-soft)]", i.id === currentId && "bg-[var(--kn-yellow-soft)]")}>
                  <FileText className="size-3.5 shrink-0 text-[#ea580c]" />
                  <span className="font-medium text-[var(--kn-text)]">{i.number}</span>
                  <span className="truncate text-[var(--kn-text-muted)]">· {i.site} · {i.commune}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-[var(--kn-text-muted)]">{frDate(i.date)}</span>
                  {i.id === currentId && <Check className="size-3.5 shrink-0 text-[#ea580c]" />}
                </button>
              ))}
              {filtered.length === 0 && <p className="px-3 py-4 text-center text-[12px] text-[var(--kn-text-muted)]">Aucune facture ne correspond.</p>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Sel({ value, onChange, icon, placeholder, options }: {
  value: string; onChange: (v: string) => void; icon: React.ReactNode; placeholder: string; options: string[];
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-2 text-[12px]">
      <span className="text-[var(--kn-text-muted)]">{icon}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="h-8 w-full bg-transparent text-[var(--kn-text)] focus:outline-none">
        <option value="">{placeholder}</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}
