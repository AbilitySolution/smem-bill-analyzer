"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FileSpreadsheet, Loader2, Check, X, Calendar, MapPin, Building2, Layers3, Download, Sparkles,
} from "lucide-react";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

interface Commune { id: string; nom: string }
interface Site { id: string; nom: string; commune_id: string; categorie: "batiment" | "eclairage_public" }
export interface BuilderInvoice {
  id: string; number: string; date: string; communeId: string; siteId: string;
  categorie: "batiment" | "eclairage_public"; isDuplicata: boolean;
}

const SHEETS: { id: string; label: string; desc: string }[] = [
  { id: "synthese", label: "Synthèse", desc: "KPIs globaux + récap par commune" },
  { id: "factures", label: "Factures", desc: "Une ligne par facture (HT, TVA, TTC, kWh, PDL…)" },
  { id: "consommation", label: "Consommation détaillée", desc: "Une ligne par période (poste HP/HC/Base)" },
  { id: "communes", label: "Par commune", desc: "Agrégat : sites, factures, kWh, €, prix moyen" },
  { id: "postes", label: "Par poste HP/HC/Base", desc: "Répartition heures pleines / creuses / base" },
  { id: "taxes", label: "Taxes & charges", desc: "Détail des taxes et parts fixes" },
];

export function ExcelBuilder({
  communes, sites, invoices, preselectedIds,
}: {
  communes: Commune[]; sites: Site[]; invoices: BuilderInvoice[]; preselectedIds: string[];
}) {
  const router = useRouter();
  const [usePre, setUsePre] = useState(preselectedIds.length > 0);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [communeIds, setCommuneIds] = useState<Set<string>>(new Set());
  const [siteIds, setSiteIds] = useState<Set<string>>(new Set());
  const [categorie, setCategorie] = useState<"all" | "batiment" | "eclairage_public">("all");
  const [includeDuplicatas, setIncludeDuplicatas] = useState(true);
  const [sheets, setSheets] = useState<Set<string>>(new Set(SHEETS.map((s) => s.id)));
  const [filename, setFilename] = useState("rapport-ability");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableSites = useMemo(
    () => (communeIds.size ? sites.filter((s) => communeIds.has(s.commune_id)) : sites),
    [sites, communeIds],
  );

  // Compteur live
  const matchCount = useMemo(() => {
    if (usePre) return preselectedIds.length;
    return invoices.filter((i) =>
      (!from || i.date >= from) &&
      (!to || i.date <= to) &&
      (communeIds.size === 0 || communeIds.has(i.communeId)) &&
      (siteIds.size === 0 || siteIds.has(i.siteId)) &&
      (categorie === "all" || i.categorie === categorie) &&
      (includeDuplicatas || !i.isDuplicata),
    ).length;
  }, [usePre, preselectedIds, invoices, from, to, communeIds, siteIds, categorie, includeDuplicatas]);

  const toggle = <T,>(set: Set<T>, v: T) => { const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); return n; };

  async function generate() {
    if (matchCount === 0) { setError("Aucune facture dans ce périmètre."); return; }
    if (sheets.size === 0) { setError("Sélectionnez au moins une feuille."); return; }
    setBusy(true); setError(null);
    try {
      const payload = {
        ids: usePre ? preselectedIds : undefined,
        from: from || undefined, to: to || undefined,
        communeIds: communeIds.size ? [...communeIds] : undefined,
        siteIds: siteIds.size ? [...siteIds] : undefined,
        categorie: categorie === "all" ? undefined : categorie,
        includeDuplicatas,
        sheets: [...sheets],
        filename,
      };
      const res = await fetch("/api/export/excel", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); setError(j.error ?? "Erreur de génération."); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = (filename.trim() || "rapport-ability") + ".xlsx"; a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Erreur réseau lors de la génération.");
    } finally {
      setBusy(false);
    }
  }

  const Chip = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button onClick={onClick}
      className={cx("rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors",
        on ? "border-[#f97316] bg-[#f97316] text-white" : "border-[var(--kn-border)] bg-[var(--kn-card)] text-[var(--kn-text-muted)] hover:border-[#fb923c]")}>
      {children}
    </button>
  );

  const Section = ({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) => (
    <section className="rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-4">
      <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-[var(--kn-text)]">
        <span className="text-[#ea580c]">{icon}</span>{title}
      </h3>
      {children}
    </section>
  );

  return (
    <div className="mx-auto max-w-4xl px-8 py-6">
      <div className="mb-1 flex items-center gap-2">
        <FileSpreadsheet className="size-5 text-[#ea580c]" />
        <h2 className="font-heading text-lg font-bold text-[var(--kn-text)]">Générer un rapport Excel</h2>
      </div>
      <p className="mb-5 text-[13px] text-[var(--kn-text-muted)]">
        Choisissez le périmètre et les feuilles à inclure. Le classeur est généré côté serveur avec mise en forme (en-têtes orange, totaux, formats €/kWh).
      </p>

      {usePre && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-[#fed7aa] bg-[var(--kn-yellow-soft)] px-4 py-2.5">
          <span className="flex items-center gap-2 text-[13px] font-medium text-[#9a3412]">
            <Sparkles className="size-4" /> {preselectedIds.length} facture{preselectedIds.length > 1 ? "s" : ""} présélectionnée{preselectedIds.length > 1 ? "s" : ""} depuis votre sélection
          </span>
          <button onClick={() => { setUsePre(false); router.replace("/documents/export"); }} className="flex items-center gap-1 text-[12px] font-medium text-[#9a3412] hover:underline">
            <X className="size-3.5" /> Utiliser les filtres à la place
          </button>
        </div>
      )}

      <div className={cx("grid gap-4 lg:grid-cols-2", usePre && "pointer-events-none opacity-50")}>
        <Section icon={<Calendar className="size-4" />} title="Période">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-[12px] text-[var(--kn-text-muted)]">Du
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-[var(--kn-border)] px-2 text-sm focus:border-[#f97316] focus:outline-none" />
            </label>
            <label className="text-[12px] text-[var(--kn-text-muted)]">Au
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-[var(--kn-border)] px-2 text-sm focus:border-[#f97316] focus:outline-none" />
            </label>
          </div>
        </Section>

        <Section icon={<Building2 className="size-4" />} title="Catégorie & doublons">
          <div className="flex flex-wrap items-center gap-1.5">
            {([["all", "Toutes"], ["batiment", "Bâtiments"], ["eclairage_public", "Éclairage"]] as const).map(([v, l]) => (
              <Chip key={v} on={categorie === v} onClick={() => setCategorie(v)}>{l}</Chip>
            ))}
            <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--kn-text-muted)]">
              <input type="checkbox" checked={includeDuplicatas} onChange={(e) => setIncludeDuplicatas(e.target.checked)} className="accent-[#f97316]" />
              Inclure les duplicatas
            </label>
          </div>
        </Section>

        <Section icon={<MapPin className="size-4" />} title="Communes">
          <div className="flex flex-wrap gap-1.5">
            {communes.map((c) => (
              <Chip key={c.id} on={communeIds.has(c.id)} onClick={() => { setCommuneIds((s) => toggle(s, c.id)); setSiteIds(new Set()); }}>{c.nom}</Chip>
            ))}
            {communes.length === 0 && <span className="text-[12px] text-[var(--kn-text-muted)]">Aucune commune.</span>}
          </div>
        </Section>

        <Section icon={<Building2 className="size-4" />} title="Sites">
          <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
            {availableSites.map((s) => (
              <Chip key={s.id} on={siteIds.has(s.id)} onClick={() => setSiteIds((set) => toggle(set, s.id))}>{s.nom}</Chip>
            ))}
            {availableSites.length === 0 && <span className="text-[12px] text-[var(--kn-text-muted)]">Aucun site.</span>}
          </div>
        </Section>
      </div>

      <div className="mt-4">
        <Section icon={<Layers3 className="size-4" />} title="Feuilles à inclure">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {SHEETS.map((s) => {
              const on = sheets.has(s.id);
              return (
                <button key={s.id} onClick={() => setSheets((set) => toggle(set, s.id))}
                  className={cx("flex items-start gap-2 rounded-lg border p-2.5 text-left transition-colors",
                    on ? "border-[#f97316]" : "border-[var(--kn-border)] hover:border-[#fb923c]")}>
                  <span className={cx("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border", on ? "border-[#f97316] bg-[#f97316] text-white" : "border-[var(--kn-border)] text-transparent")}>
                    <Check className="size-3" strokeWidth={3} />
                  </span>
                  <span>
                    <span className="block text-[13px] font-medium text-[var(--kn-text)]">{s.label}</span>
                    <span className="block text-[11px] text-[var(--kn-text-muted)]">{s.desc}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Section>
      </div>

      {/* Barre de génération */}
      <div className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--kn-border)] bg-[var(--kn-panel)] p-3">
        <label className="flex items-center gap-2 text-[12px] text-[var(--kn-text-muted)]">
          Nom du fichier
          <input value={filename} onChange={(e) => setFilename(e.target.value)} className="h-9 w-48 rounded-lg border border-[var(--kn-border)] px-2 text-sm focus:border-[#f97316] focus:outline-none" />
          <span className="text-[var(--kn-text-muted)]">.xlsx</span>
        </label>
        <span className="rounded-full bg-[var(--kn-card)] px-3 py-1.5 text-[13px] font-semibold text-[var(--kn-text)]">
          {matchCount} facture{matchCount > 1 ? "s" : ""} · {sheets.size} feuille{sheets.size > 1 ? "s" : ""}
        </span>
        <button onClick={generate} disabled={busy || matchCount === 0 || sheets.size === 0}
          className="ml-auto flex items-center gap-2 rounded-lg bg-[#f97316] px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#ea580c] disabled:opacity-50">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          {busy ? "Génération…" : "Générer le rapport Excel"}
        </button>
      </div>
      {error && <p className="mt-2 text-[13px] text-[#d33]">{error}</p>}
    </div>
  );
}
