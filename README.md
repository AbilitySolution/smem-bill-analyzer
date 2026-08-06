# Ability — Gestion documentaire & factures d'énergie

Outil de centralisation de documents et d'**extraction intelligente des factures d'électricité** (bâtiments publics & éclairage public) : visionneuse PDF + correction des champs extraits, analyses de consommation, **rapports Excel multi-feuilles**, détection d'**anomalies** (version bêta) et **thème clair/sombre**.

Stack : **Next.js 16** (App Router) · **React 19** · **Tailwind CSS v4** · **Supabase** (Postgres + Auth + Storage) · **Anthropic Claude** (OCR/extraction) · **Recharts** · **openpyxl (Python)** · **pdf.js** · **JSZip**.



## Prérequis

- **Node.js ≥ 22** — version épinglée par [.nvmrc](.nvmrc) (`nvm use` à la racine) et par `engines` dans [package.json](package.json). Sur Node 20.11 ou antérieur, `npm test` **échoue au démarrage** (`SyntaxError: ... does not provide an export named 'styleText'`) : Vitest 4 importe `styleText` de `node:util`, ajouté seulement en Node 20.12. Node 20 est par ailleurs en fin de support.
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

> La file de traitement des documents tourne dans Supabase (Edge Functions + pg_cron)
> et non dans Next.js : sa configuration est décrite dans
> [File de traitement des documents](#file-de-traitement-des-documents).

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

> **Deux ordonnanceurs coexistent, aux rôles distincts :**
>
> - `pg_cron` **dans Supabase** pilote les workers d'extraction (dispatch, collecte,
>   mode direct) — voir `supabase/migrations/20260805000000_document_queue.sql`.
> - **Vercel Cron** (`vercel.json`) pilote ce qui a besoin du code applicatif Next :
>   l'enregistrement automatique (`/api/document-jobs/auto-save`, toutes les 2 min) et
>   la maintenance quotidienne (`/api/cron/maintenance`). Ces routes exigent
>   `Authorization: Bearer $CRON_SECRET` — définissez la variable `CRON_SECRET` sur
>   Vercel, sans quoi elles répondent 401 et rien ne tourne.
>   ⚠️ Les fréquences infra-quotidiennes exigent le plan Vercel **Pro** ; en Hobby,
>   faites appeler les mêmes URL par `pg_cron` + `pg_net` avec le même en-tête.
>
> Si un cron Vercel pointe encore sur `/api/cron/sync-batches` (ancien import en lot),
> supprimez-le : la route n'existe plus.

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
- **Import** (`/upload`) : fichiers, **dossier** ou **archive ZIP**, de 1 à 200 documents. Le mode de traitement est choisi automatiquement (rapide en deçà de 20 documents, par lots à **−50 % sur les tokens** au-delà), le suivi est en **temps réel**, et les factures à haute confiance sont **enregistrées automatiquement**. Voir [File de traitement des documents](#file-de-traitement-des-documents).
- **Rapports** : flux unique « Générer un rapport Excel » — 3 rapports (Par commune, Avant/après travaux, Synthèse) générés en **Python/openpyxl** : **séries temporelles** (axes et unités affichés, fenêtre de travaux marquée), **TCD natifs** actualisés à l'ouverture, décomposition Base/HP/HC/part fixe/taxes, avant/après aux **dates de travaux réelles SMEM** (fenêtre exclue, moyennes annualisées), périodes ventilées au pro-rata des jours ; case « données du connecteur data logger » (démo / placeholder) ; présélection de factures depuis Mes documents.
- **Connecteurs** (version bêta) : aperçu des sources externes à venir (EDF, dépôt des communes, data loggers d'armoires, IPPER) — non fonctionnel à ce stade.
- **Analyse de consommation** : évolution + répartition heures pleines/creuses (kWh / € / c€).
- **Anomalies** (version bêta) : détection par règles (cohérence des totaux, coût unitaire atypique…), graphiques interactifs, résolution + **historique**.
- **Documentation** : guide d'utilisation page par page + onglet « Champs d'extraction » (modèle OCR).

## File de traitement des documents

L'extraction est une file durable hébergée dans Supabase. **L'état métier vit dans
`public.document_jobs` ; pgmq ne transporte que des identifiants de job.** Un message
perdu ne perd donc jamais de document : la ligne reste en base et reste relançable.

### Deux modes, choisis automatiquement

| | **rapide** (`direct`) | **par lots** (`batch`) |
|---|---|---|
| Déclencheur | ≤ 20 documents | > 20 documents |
| API | Messages (synchrone) | Message Batches (asynchrone) |
| Passe par pgmq | non | oui |
| Worker | `process-direct-documents` | `process-document-queue` + `collect-document-batches` |
| Latence | quelques secondes par document | minutes à heures |
| Coût | plein tarif | **−50 %** |

### Le parcours

1. `/upload` accepte des fichiers, un **dossier** ou une **archive ZIP** (dézippée dans
   le navigateur avec JSZip). Extension, taille et **magic bytes** sont vérifiés côté
   client pour un retour immédiat.
2. `POST /api/document-jobs` revérifie tout — un `.pdf` qui n'en est pas un est rejeté
   ici — écrit le fichier sous `invoice-files/{org_id}/{user_id}/queue/…` et crée le job.
   En mode `batch`, le job est mis en file pgmq.
3. Les workers (Edge Functions Deno) **pré-filtrent** avec un modèle bon marché : un
   bordereau récapitulatif ou un courrier est marqué `rejected_non_invoice` sans payer
   l'extraction complète. Le pré-filtre en panne laisse passer — il ne perd rien.
4. Le résultat passe le job en `needs_review`. La page suit la progression en
   **Realtime** ; un sondage prend le relais si le canal décroche.
5. `POST /api/document-jobs/auto-save` enregistre automatiquement les factures dont
   **l'extraction ET le rapprochement de commune sont ≥ 96 %** (statut `pending_review`,
   `auto_saved = true`). Le reste part en révision manuelle sur `/upload/review?job=…`,
   commune pré-remplie.

### Ce qu'il faut savoir

- **L'onglet peut être fermé.** Trois `pg_cron` (une par worker, toutes les minutes)
  reprennent le travail. Les invocations depuis le navigateur ne sont qu'un
  raccourci pour ne pas attendre le tick suivant.
- **Facture déjà en base** → le job est clos en pointant la facture existante
  (contrôle sur `facture_number`), aucun doublon créé.
- **Rejet à tort** → « Traiter quand même » relance en forçant l'extraction
  (`skip_prefilter`), sans repasser par le classifieur.
- **Plafonds** : 20 Mo par document, 200 documents et 500 Mo par sélection, 100 Mo par
  archive. Contrôlés des deux côtés.
- **Les fichiers distants sont toujours supprimés** après extraction, et le fichier du
  bucket l'est à la suppression d'un job : pas d'orphelin.

### Mise en service

Le code applicatif ne suffit pas — la file a trois dépendances côté Supabase.

```bash
# 1. Schéma (crée document_jobs, la file pgmq, les fonctions et les 3 cron)
supabase db push

# 2. Workers
supabase functions deploy process-document-queue
supabase functions deploy collect-document-batches
supabase functions deploy process-direct-documents
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
```

3. **Secrets Vault** — sans eux, les `pg_cron` s'exécutent mais n'appellent rien, et
   **l'échec est silencieux** :

```sql
select vault.create_secret('https://<votre-projet>.supabase.co', 'project_url');
select vault.create_secret('<clé service role>', 'service_role_key');
```

Contrôle rapide :

```sql
select jobname, schedule, active from cron.job;                 -- 3 lignes actives
select status, count(*) from public.document_jobs group by 1;   -- rien de bloqué
```

Retour arrière : voir `supabase/rollback/`.

## Structure du projet

```
app/
  (app)/                       # espace authentifié (barre supérieure + sidebar Ability)
    documents/                 # hub Mes documents : page (liste 3 vues) + extraction/ (éditeur)
    rapport-excel/             # générateur de rapports Excel
    analyses/                  # graphiques de consommation
    anomalies/                 # module Anomalies (version bêta)
    documentation/             # guide + onglet champs/ (modèle d'extraction)
    upload/                    # import des factures + review/ (révision d'un document extrait)
  api/                         # routes API (document-jobs, invoices, reports, sites, communes…)
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
  documents/                   # garde-fous de la file + estimation de durée
  supabase/                    # clients Supabase (server/browser)
supabase/
  migrations/                  # schéma de la base
  rollback/                    # retours arrière, un fichier par migration
  functions/                   # Edge Functions Deno : workers de la file de traitement
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
| `/upload`                                                     | import des factures (fichiers, dossier ou ZIP) + file de traitement en temps réel                                                      |
| `/upload/review?job=`                                         | révision d'un document extrait avant enregistrement                                                                                    |
| `/factures`, `/factures/[id]`, `/documents/export`, `/champs` | anciennes routes — redirigent vers les nouvelles                                                                                       |

## Base de données

Le schéma (tables `invoices`, `clients`, `contracts`, `sites`, `communes`, `consumption_periods`, `invoice_charges`, `anomalies`, …) est dans `supabase/migrations/`. Appliquez les migrations sur votre projet Supabase (CLI Supabase ou dashboard) avant le premier lancement.

Colonnes notables sur `invoices` : `archived` (masquage), `precision` (jsonb — score de précision par champ, renseigné aux nouveaux imports), `file_path` (PDF dans le bucket `invoice-files`), `auto_saved` (facture créée par la file sans relecture humaine).

`document_jobs` / `document_batches` portent la file de traitement — voir [File de traitement des documents](#file-de-traitement-des-documents).

> **Détection d'anomalies & résolutions** : la détection actuelle est un _fallback_ par règles (cohérence des totaux, coût/kWh atypique vs médiane annuelle) calculé à la volée ; les résolutions sont mémorisées côté navigateur (localStorage). Le suivi en base arrivera avec la version complète du module.

## Données de démonstration (seed)

`scripts/seed-demo.ts` peuple la base avec des **factures simulées réalistes** (8 communes, ~76 sites, ~1 100 factures semestrielles 2019→2026) calées sur les données réelles de Fonds-Saint-Denis : courbe tarifaire Base/HP/HC, part fixe kVA, taxes (accise, octroi de mer), fenêtre de rénovation EP par commune (−55 % de conso après travaux). Sans artefact OCR (`raw_ocr_json`/`precision` NULL, `file_path` sentinelle `seed-sim/…`).

```bash
npx tsx scripts/seed-demo.ts --dry        # volumes sans écrire
npx tsx scripts/seed-demo.ts              # complète les semestres manquants (idempotent)
npx tsx scripts/seed-demo.ts --reset-sim  # supprime les factures SIM- puis regénère
```
