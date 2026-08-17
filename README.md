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
