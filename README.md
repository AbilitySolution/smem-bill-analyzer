# Ability — Gestion documentaire & factures d'énergie

Outil de centralisation de documents et d'**extraction intelligente des factures d'électricité** (bâtiments publics & éclairage public) : visionneuse PDF + correction des champs extraits, analyses de consommation, **rapports Excel multi-feuilles**, détection d'**anomalies** (version bêta) et **thème clair/sombre**.

Stack : **Next.js 16** (App Router) · **React 19** · **Tailwind CSS v4** · **Supabase** (Postgres + Auth + Storage) · **Anthropic Claude** (OCR/extraction) · **Recharts** · **openpyxl (Python)** · **pdf.js** · **JSZip**.

---

## ⚠️ Important — la nouvelle app est sur la branche `outil_v0`

La branche `main` contient l'**ancienne** version du dashboard. La version actuelle de l'outil vit sur la branche **`outil_v0`**. Si vous lancez `main`, vous tomberez sur l'ancienne interface.

```bash
git clone https://github.com/AbilitySolution/smem-bill-analyzer.git
cd smem-bill-analyzer
git checkout outil_v0
```

---

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

## File d'attente OCR (Supabase Queues)

Les nouveaux imports multiples utilisent une architecture asynchrone :

1. Next.js enregistre le fichier dans le bucket privé `invoice-files`.
2. Un enregistrement durable est créé dans `document_jobs`.
3. Son identifiant est envoyé dans la queue Postgres `document_ocr` (`pgmq`).
4. L'Edge Function `process-document-queue` transfère jusqu'à cinq fichiers vers Claude Files API et crée un Message Batch.
5. L'Edge Function `collect-document-batches` surveille les batches, importe le JSONL de résultats puis place chaque job en `needs_review`.
6. Supabase Cron invoque le dispatcher et le collecteur chaque minute.

Le navigateur tente aussi de démarrer le worker immédiatement après un upload. Le Cron garantit que le job sera repris si l'onglet est fermé ou si cette invocation échoue.

### Routage hybride direct / Batch

- De 1 à 10 documents inclus, les jobs utilisent `processing_mode=direct` et l'Edge Function `process-direct-documents`. Elle lance au maximum trois appels Claude Messages simultanés et le cron `process-direct-documents` reprend les jobs si l'invocation du navigateur est interrompue.
- À partir de 11 documents, les jobs utilisent `processing_mode=batch`, PGMQ et Claude Message Batches.
- Une invocation du dispatcher peut créer jusqu'à dix sous-batches de cinq documents. Le collecteur vérifie jusqu'à dix batches actifs sans blocage sur le plus ancien.
- Les timestamps `queued_at`, `dispatch_started_at`, `claude_file_uploaded_at`, `batch_created_at`, `anthropic_ended_at`, `collection_started_at` et `result_available_at` servent à mesurer chaque segment sans lire les données OCR.

### Suivi en direct et estimation

La page `/upload` charge la liste une fois, puis reçoit les changements de `document_jobs` par Supabase Realtime. Un GET de secours est effectué au maximum une fois par minute pendant un traitement actif, ainsi qu'au retour sur l'onglet ou après une erreur de canal. La migration ajoute déjà `document_jobs` à la publication `supabase_realtime` et les politiques RLS limitent chaque utilisateur à ses propres jobs.

L'estimation affichée tient compte des sous-batches de cinq documents, du dispatcher exécuté chaque minute et des durées des 100 derniers batches terminés sur 90 jours. Elle utilise les percentiles P50/P80 à partir de cinq échantillons ; avant ce seuil, une plage prudente issue du test staging est utilisée. Les durées sont recalculées par `GET /api/document-jobs` sans exposer le contenu des factures.

### Installation sur un projet Supabase

Le dépôt contient la migration et l'Edge Function, mais leur déploiement nécessite une connexion manuelle à votre compte Supabase :

```bash
npx supabase login
npx supabase link --project-ref <PROJECT_REF>
npx supabase db push
npx supabase secrets set ANTHROPIC_API_KEY=<CLE_ANTHROPIC>
npx supabase functions deploy process-document-queue
npx supabase functions deploy collect-document-batches
```

`PROJECT_REF` est le sous-domaine situé avant `.supabase.co` dans l'URL du projet.

Dans le SQL Editor Supabase, créez ensuite les deux secrets Vault utilisés par le Cron :

```sql
select vault.create_secret(
  'https://<PROJECT_REF>.supabase.co',
  'project_url'
);

select vault.create_secret(
  '<SUPABASE_SERVICE_ROLE_KEY>',
  'service_role_key'
);
```

Ces valeurs ne doivent jamais être placées dans une migration ou commitées. La migration programme automatiquement les jobs `dispatch-claude-batches` et `collect-claude-batches` toutes les minutes ; tant que les secrets Vault sont absents, elle n'envoie aucune requête.

Pour déployer le routage hybride sur le projet Supabase lié :

```bash
npx supabase db push --linked
npx supabase functions deploy process-direct-documents --project-ref hfihvslrzmlukpjjxdmy
npx supabase functions deploy process-document-queue --project-ref hfihvslrzmlukpjjxdmy
npx supabase functions deploy collect-document-batches --project-ref hfihvslrzmlukpjjxdmy
```

Vérifiez toujours que `supabase/.temp/project-ref` contient la référence staging avant ces commandes.

### Benchmark direct / Batch

Le script `scripts/benchmark-document-processing.mjs` exécute par défaut trois répétitions : direct pour 3, 5 et 10 documents, puis Batch pour 3, 5, 10 et 20 documents. Utilisez exclusivement un corpus synthétique ou de démonstration non-client.

Variables requises :

```text
BENCHMARK_EMAIL
BENCHMARK_PASSWORD
BENCHMARK_FILES_DIR
BENCHMARK_BASE_URL=http://localhost:3000
BENCHMARK_REPETITIONS=3
```

L'application doit être démarrée avec la branche et les migrations à tester, puis :

```bash
npm run benchmark:documents
```

Le script écrit une ligne JSON par exécution. La requête `supabase/benchmarks/document-processing.sql` calcule ensuite les médianes et p95 à partir des timestamps staging. Chaque exécution crée de vrais appels Anthropic payants et doit être lancée avec un budget explicitement validé.

### Vérification

Après le déploiement :

- ouvrez `/upload` et envoyez deux petits PDF ;
- vérifiez la transition `En attente` → `Extraction OCR` → `À réviser` ;
- consultez **Integrations → Queues** et **Integrations → Cron** dans Supabase ;
- consultez **Edge Functions → process-document-queue / collect-document-batches → Logs** en cas d'erreur ;
- contrôlez la table `document_jobs` dans le Table Editor.

Le dispatcher crée volontairement des sous-batches de cinq documents. Les fichiers sont référencés par `file_id`, ce qui évite de charger un dossier de 100 PDF en mémoire. Les fichiers temporaires hébergés par Claude sont supprimés après collecte du résultat.

Claude Message Batches réduit de 50 % le coût des tokens, mais le résultat est différé : la majorité des batches terminent en moins d'une heure et Anthropic autorise jusqu'à 24 heures.

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
