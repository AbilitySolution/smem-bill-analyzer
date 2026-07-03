import { Plug, Info, Zap, Inbox, Radio, Landmark, Clock } from "lucide-react";

const CONNECTEURS = [
  {
    icon: Zap,
    nom: "Espace client EDF Collectivités",
    desc: "Récupération automatique des factures et duplicatas depuis la plateforme EDF de chaque commune (accès délégué).",
    statut: "À venir",
  },
  {
    icon: Inbox,
    nom: "Dépôt des communes",
    desc: "Les communes déposent directement leurs factures dans l'outil (lien de dépôt sécurisé), avec validation SMEM avant traitement.",
    statut: "À venir",
  },
  {
    icon: Radio,
    nom: "Data loggers d'armoires",
    desc: "Données réelles de consommation des armoires d'éclairage public : allumage/extinction, puissance instantanée, coupures réseau, profil de charge.",
    statut: "À venir",
  },
  {
    icon: Landmark,
    nom: "IPPER (outil national)",
    desc: "Plateforme d'État en développement : collecte et stockage centralisés des factures des bâtiments et compteurs, échanges par API.",
    statut: "À venir",
  },
];

export default function ConnecteursPage() {
  return (
    <div className="mx-auto max-w-4xl px-8 py-6">
      <div className="mb-1 flex items-center gap-2.5">
        <Plug className="size-6 text-[#ea580c]" strokeWidth={1.9} />
        <h1 className="font-heading text-2xl font-bold text-[var(--kn-text)]">Connecteurs</h1>
        <span className="rounded-full bg-[var(--kn-yellow-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#9a3412]">
          Version bêta
        </span>
      </div>

      {/* Disclaimer */}
      <div className="mb-6 mt-3 flex items-start gap-2.5 rounded-xl border border-[#fed7aa] bg-[var(--kn-yellow-soft)] px-4 py-3">
        <Info className="mt-0.5 size-4 shrink-0 text-[#ea580c]" />
        <p className="text-[13px] text-[var(--kn-text)]">
          Ce module permettra de <strong>connecter des sources de données externes</strong> pour faciliter les imports
          et obtenir, à terme, les <strong>données réelles de consommation</strong> (plateforme EDF, dépôts des communes,
          data loggers d&apos;armoires, outil national IPPER). Les connecteurs présentés ci-dessous sont un
          <strong> aperçu non fonctionnel</strong> de ce qui arrive — aucune connexion réelle n&apos;est établie à ce stade.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {CONNECTEURS.map((c) => (
          <section key={c.nom} className="rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-4 opacity-90">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--kn-yellow-soft)] text-[#ea580c]">
                <c.icon className="size-[18px]" strokeWidth={1.85} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-heading text-[14px] font-semibold text-[var(--kn-text)]">{c.nom}</h2>
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--kn-value-box)] px-2 py-0.5 text-[10px] font-medium text-[var(--kn-text-muted)]">
                    <Clock className="size-2.5" /> {c.statut}
                  </span>
                </div>
                <p className="mt-1 text-[12px] text-[var(--kn-text-muted)]">{c.desc}</p>
                <button
                  disabled
                  className="mt-3 cursor-not-allowed rounded-lg border border-[var(--kn-border)] px-3 py-1.5 text-[12px] font-medium text-[var(--kn-text-muted)] opacity-60"
                  title="Disponible dans une prochaine version"
                >
                  Connecter — bientôt disponible
                </button>
              </div>
            </div>
          </section>
        ))}
      </div>

      <p className="mt-5 text-[12px] text-[var(--kn-text-muted)]">
        En attendant, la case « Inclure les données du connecteur data logger » du module Rapports insère des
        données de démonstration clairement identifiées, dans une section distincte des analyses tarifaires.
      </p>
    </div>
  );
}
