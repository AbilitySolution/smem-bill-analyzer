"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Search, Sun, Moon, FileText, ScanText, FileSpreadsheet, Gauge, AlertTriangle, BookOpen, SlidersHorizontal, Target, UploadCloud, CornerDownLeft,
} from "lucide-react";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

interface Dest { label: string; href: string; hint: string; icon: typeof FileText }
const DESTINATIONS: Dest[] = [
  { label: "Mes documents", href: "/documents", hint: "Liste des factures", icon: FileText },
  { label: "Extraction", href: "/documents/extraction", hint: "Éditer une facture", icon: ScanText },
  { label: "Rapports", href: "/rapport-excel", hint: "Rapports prédéfinis + export personnalisé", icon: FileSpreadsheet },
  { label: "Analyse de consommation", href: "/analyses", hint: "Graphiques kWh / € / c€", icon: Gauge },
  { label: "Anomalies", href: "/anomalies", hint: "Contrôles & alertes", icon: AlertTriangle },
  { label: "Importer une facture", href: "/upload", hint: "OCR d'un nouveau document", icon: UploadCloud },
  { label: "Documentation", href: "/documentation", hint: "Guide d'utilisation des pages", icon: BookOpen },
  { label: "Champs d'extraction", href: "/documentation/champs", hint: "Modèle d'extraction", icon: SlidersHorizontal },
  { label: "Qualité d'extraction", href: "/documentation/qualite", hint: "Précision mesurée sur les corrections", icon: Target },
];

export function TopBar() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return DESTINATIONS;
    return DESTINATIONS.filter((d) => d.label.toLowerCase().includes(q) || d.hint.toLowerCase().includes(q));
  }, [query]);

  useEffect(() => { setActive(0); }, [query]);

  // Raccourci ⌘K / Ctrl+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function go(href: string) {
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
    router.push(href);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (results[active]) go(results[active].href); }
    else if (e.key === "Escape") { setOpen(false); inputRef.current?.blur(); }
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--kn-border)] bg-[var(--kn-card)] px-4">
      {/* Recherche de navigation */}
      <div className="relative mx-auto w-full max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--kn-text-muted)]" strokeWidth={1.75} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          placeholder="Rechercher une page, un onglet…"
          className="h-8 w-full rounded-lg border border-[var(--kn-border)] bg-[var(--kn-page)] pl-9 pr-12 text-[13px] text-[var(--kn-text)] focus:border-[#f97316] focus:outline-none"
        />
        <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-[var(--kn-border)] bg-[var(--kn-panel)] px-1.5 py-0.5 text-[10px] text-[var(--kn-text-muted)]">⌘K</kbd>

        {open && results.length > 0 && (
          <div className="absolute left-0 right-0 top-full z-50 mt-1.5 overflow-hidden rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] py-1 shadow-xl">
            {results.map((d, i) => (
              <button
                key={d.href}
                onMouseDown={(e) => { e.preventDefault(); go(d.href); }}
                onMouseEnter={() => setActive(i)}
                className={cx("flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px]", i === active ? "bg-[var(--kn-yellow-soft)]" : "hover:bg-[var(--kn-active)]")}
              >
                <d.icon className={cx("size-4 shrink-0", i === active ? "text-[#ea580c]" : "text-[var(--kn-text-muted)]")} />
                <span className="font-medium text-[var(--kn-text)]">{d.label}</span>
                <span className="truncate text-[12px] text-[var(--kn-text-muted)]">{d.hint}</span>
                {i === active && <CornerDownLeft className="ml-auto size-3.5 shrink-0 text-[var(--kn-text-muted)]" />}
              </button>
            ))}
          </div>
        )}
      </div>

      <ThemeToggle />
    </header>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => { setDark(document.documentElement.classList.contains("dark")); }, []);

  function toggle() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("theme", next ? "dark" : "light"); } catch { /* stockage indisponible */ }
    setDark(next);
  }

  return (
    <button
      onClick={toggle}
      aria-label={dark ? "Passer en thème clair" : "Passer en thème sombre"}
      title={dark ? "Thème clair" : "Thème sombre"}
      className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--kn-border)] text-[var(--kn-text-muted)] transition-colors hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]"
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
