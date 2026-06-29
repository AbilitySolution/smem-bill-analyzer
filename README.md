# Ability — Gestion documentaire & factures d'énergie

Outil de centralisation de documents et d'**extraction intelligente des factures d'électricité** (bâtiments publics & éclairage public), avec édition des champs extraits, analyses de consommation et export CSV.

Stack : **Next.js 16** (App Router) · **React 19** · **Tailwind CSS v4** · **Supabase** (Postgres + Auth + Storage) · **Anthropic Claude** (OCR/extraction) · **Recharts**.

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
> Les clés Supabase se trouvent dans *Project Settings → API* ; la clé Anthropic sur console.anthropic.com.

## 3. Lancer en développement

```bash
npm run dev
```

Ouvrez **http://localhost:3000**. Vous arrivez sur la page de connexion (`/login`) puis sur la liste des factures (`/factures`).

> **Authentification** : l'accès est protégé par Supabase Auth. Connectez-vous avec un compte existant du projet Supabase. Sans session valide, toutes les pages redirigent vers `/login`.

## Autres commandes

```bash
npm run build   # build de production
npm run start   # lancer le build de production
npm run lint    # linter
```

---

## Structure du projet

```
app/
  (app)/                 # espace authentifié (sidebar Ability)
    factures/            # liste des factures + détail /factures/[id]
    analyses/            # graphiques de consommation (filtres + kWh/€/c€)
    upload/              # import + extraction IA d'une facture
    champs/              # champs du modèle d'extraction
  api/                   # routes API (extract, invoices, sites, communes…)
  login/                 # authentification
components/
  factures/              # liste, détail PDF redimensionnable, édition des champs
  analyses/              # vues d'analyse (Recharts)
  koncile/               # sidebar Ability
  ui/                    # composants shadcn
lib/
  data/                  # requêtes Supabase agrégées (factures, consommation)
  anthropic/             # schéma d'extraction + client Claude
  supabase/              # clients Supabase (server/browser)
supabase/migrations/     # schéma de la base
```

## Routes principales

| Route | Description |
|-------|-------------|
| `/` | redirige vers `/factures` |
| `/factures` | liste de toutes les factures (recherche, regroupement, export CSV) |
| `/factures/[id]` | détail : PDF + tous les champs extraits éditables (onglets) |
| `/analyses` | analyses de consommation (filtres commune/site/catégorie) |
| `/upload` | import et extraction IA d'une facture |
| `/champs` | champs du modèle d'extraction |

## Base de données

Le schéma (tables `invoices`, `clients`, `contracts`, `sites`, `communes`, `consumption_periods`, `invoice_charges`, …) est dans `supabase/migrations/`. Appliquez les migrations sur votre projet Supabase (CLI Supabase ou dashboard) avant le premier lancement.
