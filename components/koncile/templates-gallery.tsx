"use client";

import { useState } from "react";
import {
  Copy,
  Search,
  LayoutGrid,
  List,
  Plus,
  MoreHorizontal,
  FileText,
  X,
} from "lucide-react";
const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

interface GalleryTemplate { id: string; name: string; docs: number; description: string }

export function TemplatesGallery({ count = 0, onOpen }: { count?: number; onOpen?: (id: string) => void }) {
  const [view, setView] = useState<"grid" | "list">("grid");
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");

  const templates: GalleryTemplate[] = [
    {
      id: "facture-elec",
      name: "Facture d'électricité",
      docs: count,
      description:
        "Toutes vos factures d'électricité (bâtiments & éclairage public) : consommation, taxes, montants et postes tarifaires extraits.",
    },
  ];

  const list = templates.filter((t) =>
    t.name.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="mx-auto max-w-5xl px-8 py-7">
      {/* En-tête */}
      <div className="mb-6 flex items-center gap-2.5">
        <Copy className="size-6 text-[var(--kn-text)]" strokeWidth={1.75} />
        <h1 className="font-heading text-2xl font-bold text-[var(--kn-text)]">Mes modèles</h1>
      </div>

      {/* Barre recherche + toggles */}
      <div className="mb-5 flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--kn-text-muted)]" strokeWidth={1.75} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher par nom"
            className="h-10 w-full rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] pl-9 pr-3 text-sm text-[var(--kn-text)] placeholder:text-[var(--kn-text-muted)] focus:border-[var(--kn-text)] focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] p-1">
          <button
            onClick={() => setView("grid")}
            className={cx("rounded-md p-1.5", view === "grid" ? "bg-[var(--kn-active)] text-[var(--kn-text)]" : "text-[var(--kn-text-muted)]")}
          >
            <LayoutGrid className="size-4" strokeWidth={2} />
          </button>
          <button
            onClick={() => setView("list")}
            className={cx("rounded-md p-1.5", view === "list" ? "bg-[var(--kn-active)] text-[var(--kn-text)]" : "text-[var(--kn-text-muted)]")}
          >
            <List className="size-4" strokeWidth={2} />
          </button>
        </div>
      </div>

      {list.length === 0 && (
        <p className="py-16 text-center text-[13px] text-[var(--kn-text-muted)]">
          Aucun modèle ne correspond à « {query} ».
        </p>
      )}

      {/* Vue grille */}
      {view === "grid" && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          {list.map((t) => (
            <div
              key={t.id}
              className="group flex flex-col overflow-hidden rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] transition-shadow hover:shadow-sm"
            >
              <div className="relative flex h-36 items-center justify-center bg-[var(--kn-panel)]">
                <ThumbInvoice />
              </div>
              <div className="flex flex-col gap-2 p-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <span className="flex size-4 items-center justify-center rounded border border-[var(--kn-border)]" />
                    <span className="font-heading text-[15px] font-semibold text-[var(--kn-text)]">{t.name}</span>
                  </div>
                  <KebabMenu onEdit={() => onOpen?.(t.id)} />
                </div>
                <span className="w-fit rounded-full bg-[var(--kn-value-box)] px-2 py-0.5 text-[11px] text-[var(--kn-text-muted)]">
                  {t.docs} documents
                </span>
                <p className="line-clamp-2 text-[12px] leading-relaxed text-[var(--kn-text-muted)]">{t.description}</p>
                <button
                  onClick={() => onOpen?.(t.id)}
                  className="mt-1 w-full rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] py-2 text-[13px] font-medium text-[var(--kn-text)] transition-colors hover:bg-[var(--kn-active)]"
                >
                  Éditer
                </button>
              </div>
            </div>
          ))}

          <button
            onClick={() => setCreating(true)}
            className="flex min-h-[260px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[#c8ccd2] bg-[var(--kn-card)] text-[var(--kn-text-muted)] transition-colors hover:border-[var(--kn-text)] hover:text-[var(--kn-text)]"
          >
            <Plus className="size-8" strokeWidth={1.25} />
            <span className="px-6 text-center text-[14px]">Créer un nouveau modèle d'extraction</span>
          </button>
        </div>
      )}

      {/* Vue liste */}
      {view === "list" && (
        <div className="overflow-hidden rounded-xl border border-[var(--kn-border)]">
          {list.map((t, i) => (
            <div
              key={t.id}
              className={cx(
                "group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-[var(--kn-active)]",
                i > 0 && "border-t border-[var(--kn-border)]",
              )}
            >
              <span className="flex size-4 shrink-0 items-center justify-center rounded border border-[var(--kn-border)]" />
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--kn-panel)]">
                <FileText className="size-4 text-[var(--kn-text-muted)]" strokeWidth={1.75} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-heading text-[14px] font-semibold text-[var(--kn-text)]">{t.name}</p>
                <p className="truncate text-[12px] text-[var(--kn-text-muted)]">{t.description}</p>
              </div>
              <span className="hidden shrink-0 rounded-full bg-[var(--kn-value-box)] px-2 py-0.5 text-[11px] text-[var(--kn-text-muted)] sm:inline">
                {t.docs} documents
              </span>
              <button
                onClick={() => onOpen?.(t.id)}
                className="shrink-0 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-4 py-1.5 text-[13px] font-medium text-[var(--kn-text)] transition-colors hover:bg-[var(--kn-card)]"
              >
                Éditer
              </button>
              <KebabMenu onEdit={() => onOpen?.(t.id)} />
            </div>
          ))}
          <button
            onClick={() => setCreating(true)}
            className="flex w-full items-center gap-2 border-t border-dashed border-[var(--kn-border)] px-4 py-3 text-[13px] font-medium text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]"
          >
            <Plus className="size-4" /> Créer un nouveau modèle d'extraction
          </button>
        </div>
      )}

      {creating && <CreateModal onClose={() => setCreating(false)} onOpen={onOpen} />}
    </div>
  );
}

function KebabMenu({ onEdit }: { onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className="rounded p-1 text-[var(--kn-text-muted)] hover:bg-[var(--kn-active)] hover:text-[var(--kn-text)]"
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-40 overflow-hidden rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] py-1 text-[13px] shadow-lg">
            <button onClick={() => { setOpen(false); onEdit(); }} className="block w-full px-3 py-1.5 text-left hover:bg-[var(--kn-active)]">Éditer</button>
            <button onClick={() => setOpen(false)} className="block w-full px-3 py-1.5 text-left hover:bg-[var(--kn-active)]">Dupliquer</button>
            <button onClick={() => setOpen(false)} className="block w-full px-3 py-1.5 text-left hover:bg-[var(--kn-active)]">Renommer</button>
            <div className="my-1 border-t border-[var(--kn-border)]" />
            <button onClick={() => setOpen(false)} className="block w-full px-3 py-1.5 text-left text-[#d33] hover:bg-[var(--kn-active)]">Supprimer</button>
          </div>
        </>
      )}
    </div>
  );
}

function ThumbInvoice() {
  return (
    <div className="relative h-26 w-32">
      {/* feuilles empilées en arrière-plan */}
      <div className="absolute left-7 top-1 h-24 w-24 rotate-6 rounded-lg bg-[#e7e9fb] shadow-sm" />
      <div className="absolute left-4 top-0.5 h-24 w-24 rotate-3 rounded-lg bg-[var(--kn-yellow-soft)] shadow-sm" />
      {/* facture au premier plan */}
      <div className="absolute left-1 top-0 flex h-24 w-24 flex-col gap-1 rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] p-2.5 shadow">
        <span className="font-heading text-[10px] font-bold text-[var(--kn-text)]">Facture</span>
        <span className="h-1 w-9 rounded bg-[#e5e7eb]" />
        <span className="h-1 w-12 rounded bg-[#eceef1]" />
        <span className="mt-1 h-1.5 w-full rounded-sm bg-[var(--kn-yellow)]" />
        <span className="h-1.5 w-full rounded-sm bg-[var(--kn-yellow)]" />
        <span className="h-1.5 w-2/3 rounded-sm bg-[var(--kn-yellow)]" />
      </div>
    </div>
  );
}

function CreateModal({ onClose, onOpen }: { onClose: () => void; onOpen?: (id: string) => void }) {
  const [tab, setTab] = useState<"scratch" | "ready" | "yours">("ready");
  const tabs = [
    { id: "scratch", label: "Partir de zéro" },
    { id: "ready", label: "Modèles prêts à l'emploi" },
    { id: "yours", label: "Mes modèles" },
  ] as const;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-xl rounded-2xl bg-[var(--kn-card)] p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <FileText className="size-5 text-[var(--kn-text)]" strokeWidth={1.75} />
            <h2 className="font-heading text-lg font-bold text-[var(--kn-text)]">
              Créer un nouveau modèle d'extraction
            </h2>
          </div>
          <button onClick={onClose} className="text-[var(--kn-text-muted)] hover:text-[var(--kn-text)]">
            <X className="size-5" />
          </button>
        </div>

        {/* Onglets segmentés */}
        <div className="mb-5 flex rounded-lg bg-[var(--kn-panel)] p-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cx(
                "flex-1 rounded-md py-1.5 text-[13px] font-medium transition-colors",
                tab === t.id ? "bg-[var(--kn-card)] text-[var(--kn-text)] shadow-sm" : "text-[var(--kn-text-muted)]",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <p className="mb-4 text-[13px] text-[var(--kn-text-muted)]">
          Sélectionnez un modèle pré-conçu dans notre bibliothèque et personnalisez-le selon vos besoins.
        </p>

        <div className="mb-4 flex items-center gap-6 text-[13px]">
          <label className="flex items-center gap-2">
            <span className="flex size-4 items-center justify-center rounded-full border-2 border-[var(--kn-text)]">
              <span className="size-2 rounded-full bg-[var(--kn-solid)]" />
            </span>
            Modèles français
          </label>
          <label className="flex items-center gap-2 text-[var(--kn-text-muted)]">
            <span className="size-4 rounded-full border-2 border-[#c8ccd2]" />
            Modèles anglais
          </label>
        </div>

        <button className="mb-5 flex h-10 w-full items-center justify-between rounded-lg border border-[var(--kn-border)] bg-[var(--kn-card)] px-3 text-[13px] text-[var(--kn-text-muted)]">
          Sélectionner un modèle
          <span className="text-[var(--kn-text-muted)]">▾</span>
        </button>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-[var(--kn-border)] px-4 py-2 text-[13px] font-medium text-[var(--kn-text)] hover:bg-[var(--kn-active)]">
            Annuler
          </button>
          <button
            onClick={() => {
              onClose();
              onOpen?.("facture-elec");
            }}
            className="rounded-lg bg-[var(--kn-solid)] px-5 py-2 text-[13px] font-medium text-white hover:opacity-90"
          >
            Créer
          </button>
        </div>
      </div>
    </div>
  );
}
