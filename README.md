# Ability — Gestion documentaire & factures d'énergie

Outil de centralisation de documents et d'**extraction intelligente des factures d'électricité** (bâtiments publics & éclairage public) : visionneuse PDF + correction des champs extraits, analyses de consommation, **rapports Excel multi-feuilles**, détection d'**anomalies** (version bêta) et **thème clair/sombre**.

Stack : **Next.js 16** (App Router) · **React 19** · **Tailwind CSS v4** · **Supabase** (Postgres + Auth + Storage) · **Anthropic Claude** (OCR/extraction) · **Recharts** · **openpyxl (Python)** · **pdf.js** · **JSZip**.



## Prérequis

- **Node.js ≥ 20** (testé sur Node 25) et **npm**
- **Python 3 + openpyxl** (`pip3 install openpyxl`) — requis pour la génération des rapports Excel (graphiques + TCD natifs)
- Un projet **Supabase** (URL + clés)
- Une **clé API Anthropic**

## 1. Installer les dépendances

```bash
npm install
```

## 2. Configurer l'environnement

Créez un fichier **`.env.local`** à la racine avec :

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<votre-projet>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<clé anon publique>
SUPABASE_SERVICE_ROLE_KEY=<clé service role (serveur uniquement)>
ANTHROPIC_API_KEY=<clé API Anthropic (sk-ant-...)>
```

> `.env.local` est ignoré par git — ne le committez jamais.
> Les clés Supabase se trouvent dans _Project Settings → API_ ; la clé Anthropic sur console.anthropic.com.

## 3. Lancer en développement

```bash
npm run dev
```

Ouvrez **http://localhost:3000**. Vous arrivez sur la page de connexion (`/login`) puis sur le hub **Mes documents** (`/documents`).

> **Authentification** : l'accès est protégé par Supabase Auth. Connectez-vous avec un compte existant du projet Supabase. Sans session valide, toutes les pages redirigent vers `/login`.

## Autres commandes

```bash
npm run build   # build de production
npm run start   # lancer le build de production
npm run lint    # linter
```

---

## 🚀 Déploiement gratuit pour test client (Vercel)

Pour permettre au client de tester la plateforme simplement, la solution la plus pratique et gratuite pour le moment est **Vercel**.

### Pourquoi Vercel ?

- déploiement rapide en quelques clics
- gratuit pour un usage de test et de démonstration
- compatible avec Next.js sans configuration supplémentaire
- simple à partager via une URL publique

### Étapes

1. Poussez votre code sur GitHub
2. Créez un compte sur https://vercel.com
3. Cliquez sur “Add New Project” puis choisissez votre dépôt GitHub
4. Vercel détecte automatiquement Next.js
5. Ajoutez les variables d’environnement suivantes dans l’onglet “Environment Variables” :

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<votre-projet>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<clé anon publique>
SUPABASE_SERVICE_ROLE_KEY=<clé service role>
ANTHROPIC_API_KEY=<clé API Anthropic>
```

6. Déployez

Votre application sera alors disponible sur une URL du type :

```text
https://<nom-du-projet>.vercel.app
```

### Conseils pratiques

- utilisez une branche dédiée pour les tests clients, par exemple `staging` ou `preview`
- gardez un environnement Supabase distinct pour les tests si vous voulez éviter d’affecter la production
- pour un test simple, il suffit de partager l’URL Vercel au client

### Variables d’environnement attendues

Un fichier exemple est disponible dans [.env.example](.env.example).

---

## Fonctionnalités

- **Barre supérieure** globale : recherche de navigation (⌘K) vers n'importe quelle page, bascule **thème clair/sombre** (persistée).
- **Hub « Mes documents »** : vues **Liste / Galerie** (vignette réelle de la 1ʳᵉ page du PDF) **/ Colonnes**, regroupement (commune/site/catégorie), recherche, **scores de confiance** OCR, **tickers d'anomalie**, sélection multiple → actions groupées (masquer/démasquer, supprimer, télécharger les PDF en ZIP, exporter), export **CSV** filtré.
- **Extraction** : sélecteur de facture + visionneuse PDF redimensionnable + **tous les champs éditables** (corrections journalisées).
- **Rapports** : flux unique « Générer un rapport Excel » — 3 rapports (Par commune, Avant/après travaux, Synthèse) générés en **Python/openpyxl** : **séries temporelles** (axes et unités affichés, fenêtre de travaux marquée), **TCD natifs** actualisés à l'ouverture, décomposition Base/HP/HC/part fixe/taxes, avant/après aux **dates de travaux réelles SMEM** (fenêtre exclue, moyennes annualisées), périodes ventilées au pro-rata des jours ; case « données du connecteur data logger » (démo / placeholder) ; présélection de factures depuis Mes documents.
- **Connecteurs** (version bêta) : aperçu des sources externes à venir (EDF, dépôt des communes, data loggers d'armoires, IPPER) — non fonctionnel à ce stade.
- **Analyse de consommation** : évolution + répartition heures pleines/creuses (kWh / € / c€).
- **Anomalies** (version bêta) : détection par règles (cohérence des totaux, coût unitaire atypique…), graphiques interactifs, résolution + **historique**.
- **Documentation** : guide d'utilisation page par page + onglet « Champs d'extraction » (modèle OCR).

## Structure du projet

```
app/
  (app)/                       # espace authentifié (barre supérieure + sidebar Ability)
    documents/                 # hub Mes documents : page (liste 3 vues) + extraction/ (éditeur)
    rapport-excel/             # générateur de rapports Excel
    analyses/                  # graphiques de consommation
    anomalies/                 # module Anomalies (version bêta)
    documentation/             # guide + onglet champs/ (modèle d'extraction)
    upload/                    # import + extraction OCR d'une facture
  api/                         # routes API (extract, invoices, reports, sites, communes…)
  login/                       # authentification
components/
  app-shell/                   # barre supérieure (recherche nav + thème)
  documents/                   # hub, vues, sélection/actions, vignette PDF, badges
  documentation/               # onglets de la page Documentation
  anomalies/                   # vue du module Anomalies
  factures/                    # visionneuse PDF, panneau d'extraction éditable
  analyses/                    # vues d'analyse (Recharts)
  koncile/                     # sidebar Ability
  ui/                          # composants shadcn
lib/
  data/                        # requêtes Supabase agrégées (factures, consommation) + détection d'anomalies
  anthropic/                   # schéma d'extraction + client Claude
  supabase/                    # clients Supabase (server/browser)
supabase/migrations/           # schéma de la base
```

## Routes principales

| Route                                                         | Description                                                                                                                            |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                                           | redirige vers `/documents`                                                                                                             |
| `/documents`                                                  | hub Mes documents : vues Liste/Galerie/Colonnes, regroupement, confiance, tickers d'anomalie, sélection & actions groupées, export CSV |
| `/documents/extraction?id=`                                   | éditeur : sélecteur de facture + PDF redimensionnable + champs extraits éditables                                                      |
| `/rapport-excel`                                              | Générer un rapport Excel : 3 rapports (Par commune, Avant/après travaux, Synthèse) — Python/openpyxl, TCD + séries temporelles         |
| `/connecteurs`                                                | Connecteurs (version bêta) : sources de données externes à venir                                                                       |
| `/analyses`                                                   | analyses de consommation (filtres commune/site/catégorie, kWh/€/c€)                                                                    |
| `/anomalies`                                                  | module Anomalies (version bêta) : alertes, graphiques, résolution + historique                                                         |
| `/documentation` · `/documentation/champs`                    | guide d'utilisation + champs du modèle d'extraction                                                                                    |
| `/upload`                                                     | import et extraction OCR d'une facture                                                                                                 |
| `/factures`, `/factures/[id]`, `/documents/export`, `/champs` | anciennes routes — redirigent vers les nouvelles                                                                                       |

## Base de données

Le schéma (tables `invoices`, `clients`, `contracts`, `sites`, `communes`, `consumption_periods`, `invoice_charges`, `anomalies`, …) est dans `supabase/migrations/`. Appliquez les migrations sur votre projet Supabase (CLI Supabase ou dashboard) avant le premier lancement.

Colonnes notables sur `invoices` : `archived` (masquage), `precision` (jsonb — score de précision par champ, renseigné aux nouveaux imports), `file_path` (PDF dans le bucket `invoice-files`).

> **Détection d'anomalies & résolutions** : la détection actuelle est un _fallback_ par règles (cohérence des totaux, coût/kWh atypique vs médiane annuelle) calculé à la volée ; les résolutions sont mémorisées côté navigateur (localStorage). Le suivi en base arrivera avec la version complète du module.

## Données de démonstration (seed)

`scripts/seed-demo.ts` peuple la base avec des **factures simulées réalistes** (8 communes, ~76 sites, ~1 100 factures semestrielles 2019→2026) calées sur les données réelles de Fonds-Saint-Denis : courbe tarifaire Base/HP/HC, part fixe kVA, taxes (accise, octroi de mer), fenêtre de rénovation EP par commune (−55 % de conso après travaux). Sans artefact OCR (`raw_ocr_json`/`precision` NULL, `file_path` sentinelle `seed-sim/…`).

```bash
npx tsx scripts/seed-demo.ts --dry        # volumes sans écrire
npx tsx scripts/seed-demo.ts              # complète les semestres manquants (idempotent)
npx tsx scripts/seed-demo.ts --reset-sim  # supprime les factures SIM- puis regénère
```
