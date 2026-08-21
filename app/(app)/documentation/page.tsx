import { requireRole } from "@/lib/auth-guard";
import Link from "next/link";
import {
  FileText, ScanText, FileSpreadsheet, Gauge, AlertTriangle, Target, UploadCloud, SlidersHorizontal,
  ArrowRight, Lightbulb, ListChecks,
} from "lucide-react";

type Guide = {
  icon: typeof FileText;
  title: string;
  href: string;
  hrefLabel: string;
  role: string;
  steps: string[];
};

const GUIDES: Guide[] = [
  {
    icon: FileText, title: "Mes documents", href: "/documents", hrefLabel: "Ouvrir Mes documents",
    role: "Le hub central : toutes vos factures d'électricité, consultables, filtrables et exportables.",
    steps: [
      "Basculez entre les vues Liste, Galerie (vignette réelle de la facture) et Colonnes (commune → facture → aperçu).",
      "Regroupez par commune, site ou catégorie ; recherchez par n°, site ou commune.",
      "La colonne Confiance affiche la précision du modèle OCR ; un lien orange « Résoudre l'anomalie » signale les factures à vérifier.",
      "Cochez des factures pour agir en lot : masquer/démasquer, télécharger les PDF, supprimer, ou les envoyer vers Rapport Excel.",
      "Le bouton Exporter CSV reprend les filtres et regroupements en cours.",
    ],
  },
  {
    icon: ScanText, title: "Extraction", href: "/documents/extraction", hrefLabel: "Ouvrir l'extraction",
    role: "Vérifier et corriger les données extraites d'une facture, en face du PDF d'origine.",
    steps: [
      "Choisissez la facture via le sélecteur en haut (recherche + filtres commune / site / année).",
      "À gauche, le PDF : zoom plein écran, rotation, téléchargement, « Obtenir le lien ».",
      "Faites glisser la barre centrale pour ajuster la largeur du PDF.",
      "À droite, tous les champs extraits sont modifiables par onglets ; chaque correction est enregistrée et journalisée.",
    ],
  },
  {
    icon: FileSpreadsheet, title: "Rapports", href: "/rapport-excel", hrefLabel: "Ouvrir Rapports",
    role: "Un seul flux « Générer un rapport Excel » : 2 rapports (Par commune, Synthèse) avec séries temporelles, TCD natifs et décomposition tarifaire.",
    steps: [
      "1 · Choisissez le type : Par commune (séries kWh/€ pour une commune) ou Synthèse (toutes les communes).",
      "2 · Définissez le périmètre : commune, dates, sites — ou sélectionnez des factures dans Mes documents puis « Exporter Excel » (préselection automatique).",
      "Les dates sont préremplies sur la période réellement couverte par vos documents : celle de la commune choisie, ou celle de tout le portefeuille pour la synthèse.",
      "Les graphiques sont des séries temporelles avec axes et unités affichés ; les périodes de facturation sont ventilées au pro-rata des jours.",
      "Les TCD s'actualisent à l'ouverture dans Excel ; la feuille « Données » (masquée) contient le détail normalisé.",
    ],
  },
  {
    icon: Gauge, title: "Analyse de consommation", href: "/analyses", hrefLabel: "Ouvrir l'analyse",
    role: "Visualiser l'évolution de la consommation et la répartition heures pleines / heures creuses.",
    steps: [
      "Filtrez par commune, site et catégorie pour cibler le périmètre.",
      "Choisissez l'unité d'affichage : kWh, € ou c€/kWh.",
      "Le graphe d'évolution montre la tendance par année et par poste tarifaire.",
      "L'histogramme compare heures pleines / heures creuses sur la période.",
    ],
  },
  {
    icon: AlertTriangle, title: "Anomalies", href: "/anomalies", hrefLabel: "Ouvrir Anomalies", role:
      "Repérer les factures atypiques : un contrôle automatique de démonstration.",
    steps: [
      "Les alertes sont classées par gravité (élevée / moyenne / faible).",
      "Survolez un point du graphique « Montant vs consommation » : l'alerte correspondante ressort dans la liste.",
      "« Marquer résolue » envoie l'alerte dans l'Historique (où l'on peut la Rouvrir).",
      "Depuis Mes documents, le lien « Résoudre l'anomalie » mène directement ici.",
    ],
  },
  {
    icon: UploadCloud, title: "Importer une facture", href: "/upload", hrefLabel: "Importer une facture",
    role: "Ajouter une nouvelle facture : l'OCR extrait automatiquement les champs.",
    steps: [
      "Choisissez la commune puis le site (point de livraison).",
      "Glissez-déposez le PDF/image : l'extraction démarre.",
      "Vérifiez l'aperçu (avec le score de précision) puis enregistrez ; vous arrivez sur la page d'extraction.",
    ],
  },
  {
    icon: Target, title: "Qualité d'extraction", href: "/documentation/qualite", hrefLabel: "Voir la qualité",
    role: "La précision réelle de l'OCR, champ par champ, mesurée sur les corrections que vos équipes ont apportées.",
    steps: [
      "Onglet « Qualité d'extraction » de cette page.",
      "Seules les factures relues champ par champ comptent : accepter une facture sans la lire ne dit rien de la justesse de sa lecture.",
      "Les champs les moins fiables sont listés en premier — c'est là qu'il y a à agir.",
    ],
  },
  {
    icon: SlidersHorizontal, title: "Champs d'extraction", href: "/documentation/champs", hrefLabel: "Voir les champs",
    role: "Le modèle unique « Facture d'électricité » et la liste des champs lus par l'OCR.",
    steps: [
      "Consultez l'onglet « Champs d'extraction » pour voir tous les champs extraits, par groupe.",
      "L'édition des libellés et la personnalisation des champs arriveront prochainement.",
    ],
  },
];

export default async function GuidePage() {
  // La documentation décrit le paramétrage de l'extraction : elle s'adresse aux profils
  // qui pilotent la donnée, pas à l'opérateur qui dépose des factures.
  await requireRole("org_supervisor");

  return (
    <div className="mx-auto max-w-4xl px-8 py-6">
      <p className="mb-5 text-[13px] text-[var(--kn-text-muted)]">
        Une fiche par page : à quoi elle sert et comment l&apos;utiliser.
      </p>
      <div className="space-y-3">
        {GUIDES.map((g) => (
          <section key={g.title} className="rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)] p-4">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--kn-yellow-soft)] text-[#ea580c]">
                <g.icon className="size-[18px]" strokeWidth={1.85} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="font-heading text-[15px] font-semibold text-[var(--kn-text)]">{g.title}</h2>
                  <Link href={g.href} className="inline-flex items-center gap-1 text-[12px] font-medium text-[#ea580c] hover:underline">
                    {g.hrefLabel} <ArrowRight className="size-3.5" />
                  </Link>
                </div>
                <p className="mt-1 flex items-start gap-1.5 text-[13px] text-[var(--kn-text-muted)]">
                  <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-[var(--kn-text-muted)]" />
                  <span><span className="font-medium text-[var(--kn-text)]">À quoi ça sert : </span>{g.role}</span>
                </p>
                <div className="mt-2.5">
                  <p className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-[var(--kn-text)]">
                    <ListChecks className="size-3.5 text-[var(--kn-text-muted)]" /> Comment l&apos;utiliser
                  </p>
                  <ul className="space-y-1">
                    {g.steps.map((s, i) => (
                      <li key={i} className="flex gap-2 text-[13px] text-[var(--kn-text-muted)]">
                        <span className="mt-1.5 size-1 shrink-0 rounded-full bg-[#fb923c]" />
                        <span>{s}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
