# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

---

# Les trois bases, et celle sur laquelle vous travaillez

| Base | Fichier d'env | Ce que c'est |
|---|---|---|
| **Stack local** (docker) | `.env.local.stack` | Votre base de travail. Jetable, reconstructible en une commande. |
| **Projet de dev** (`hfihvslrzmlukpjjxdmy`) | `.env.local.test` | Base distante, destinée à suivre `develop`. |
| **Production** (`nymorbhybxkhcyatguzl`) | **`.env.local`** | Les factures réelles du client. |

⚠️ **`.env.local` pointe sur la PRODUCTION.** C'est le fichier que Next.js charge d'office
et celui que les scripts prennent par défaut. Un `npm run dev` ou un `npx tsx scripts/…`
lancé sans y penser travaille donc en prod. Ce n'est pas un piège théorique : c'est le
comportement par défaut du dépôt.

Pour travailler en local :

```bash
npm run dev:local
```

`dev:local` injecte `.env.local.stack`, refuse de démarrer si l'URL n'est pas locale, et
annonce sa cible au démarrage :

```
→ base visée : LOCAL  (.env.local.stack)
```

Les scripts de `scripts/` acceptent tous `--env <fichier>` (ou `SMEM_ENV_FILE`) et
impriment la même ligne avant d'écrire quoi que ce soit. **Lisez-la.** Si elle ne dit pas
`LOCAL`, vous êtes sur une base distante.

```bash
npx tsx scripts/seed-demo.ts --env .env.local.stack
```

# Toute modification de schéma commence en local

Il n'y a pas d'exception à cette règle, et elle a une raison précise : les migrations de ce
dépôt ont déjà divergé de la production une fois. Une base reconstruite depuis
`supabase/migrations/` ne donnait pas le schéma qui tournait — colonnes absentes, `NOT NULL`
manquants, index en double. La divergence a vécu des semaines sans que rien ne la signale,
et elle a laissé un bug en production (`pending_uploads.status`, une colonne que le code
lisait et qui n'existait pas). `20260820010000_reconcile_prod_schema` a remis les deux
d'accord ; le seul moyen de ne pas recommencer est de rejouer les migrations à neuf à
chaque changement.

## La boucle

```bash
npx supabase start
```

```bash
npx supabase db reset
```

`db reset` détruit la base locale et rejoue **toutes** les migrations depuis zéro. C'est le
test : si votre migration ne passe pas ici, elle ne passera pas ailleurs.

Écrivez ensuite votre fichier dans `supabase/migrations/`, nommé
`AAAAMMJJHHMMSS_sujet.sql`, puis rejouez `db reset`.

**L'horodatage doit être postérieur à la dernière migration déjà appliquée en production.**
Une migration antérieure à une migration déjà jouée est vue comme « out of order » et
`supabase db push` la refuse. C'est arrivé à `anomalies_refonte`, qu'il a fallu renommer.

Écrivez aussi le rollback correspondant dans `supabase/rollback/` — un fichier
`AAAAMMJJHHMMSS_sujet_down.sql` et une ligne dans le tableau de
[`supabase/rollback/README.md`](supabase/rollback/README.md), qui dit honnêtement ce que le
retour arrière perd.

## Les deux contrôles qui ne se voient pas dans les tests

**Les droits PostgREST.** Les migrations peuvent toutes passer au vert et laisser les
tables sans `GRANT` : PostgREST refuse alors la requête avant même que la RLS soit
consultée, et l'API entière répond en erreur. C'est déjà arrivé. Après chaque `db reset` :

```bash
npm run check:rest
```

Les dix tables doivent répondre `200`. Autre chose — 401, 403 — signifie un `GRANT`
manquant, pas un problème de RLS.

La reconstruction et ce contrôle tournent aussi en CI, dans le job `db-rebuild` de
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) — même script, pour que l'échec se
rejoue à l'identique sur votre machine.

**L'écart avec la production.** Celui-là, **la CI ne le voit pas** : elle n'a aucun accès à
la prod. C'est donc à vous de le faire quand une migration touche à une table existante.
Comparez le schéma reconstruit à celui de la production plutôt que de le supposer
identique — colonnes, contraintes, index, politiques RLS, `GRANT` et fonctions, un à un.
Le MCP Supabase interroge la prod en lecture pour ça. Une comparaison par catégorie
(`count` + `md5` d'un `string_agg` trié) suffit à repérer où creuser sans rapatrier tout le
schéma.

# Vérifier avec de vraies factures

`docs/factures/` contient une archive de **16 factures EDF réelles** (éclairage public,
contrat 236802). C'est le jeu d'essai de référence : des documents que le pipeline
d'extraction doit savoir traiter, pas des PDF fabriqués pour l'occasion.

Ces documents sont des données client : le dossier et son README sont versionnés,
**les archives ne le sont pas**. Si `docs/factures/` est vide sur votre machine, demandez
l'archive plutôt que d'improviser un jeu de test.

## Le parcours complet

```bash
npx supabase start && npx supabase db reset
```

Provisionnez une organisation et un compte administrateur sur la base locale — sans ligne
`user_roles`, `getUserContext()` renvoie `null` et toutes les pages redirigent vers `/login` :

```bash
npx tsx scripts/provision-org.ts --org "SMEM (local)" --email dev@local.test --env .env.local.stack
```

Le script imprime un mot de passe temporaire. Lancez l'application :

```bash
npm run dev:local
```

Connectez-vous, allez sur **Importer des documents**, et déposez les PDF de l'archive.
Vérifiez ensuite, dans l'ordre :

1. les lignes apparaissent dans `document_jobs`, et leur `status` progresse
   (`direct_queued` / `queued` → … → `completed`, ou `needs_review`) ;
2. les factures extraites arrivent dans `/documents` avec montants, périodes et compteurs ;
3. les analyses et les anomalies se calculent sur ces factures ;
4. le rapport Excel se génère.

L'extraction appelle Claude : renseignez `ANTHROPIC_API_KEY` dans `.env.local.stack`
(recopiez-la depuis `.env.local`). Sans cette clé, l'import, le stockage et la mise en file
fonctionnent, mais les jobs ne sont jamais extraits — c'est-à-dire que l'étape 1 s'arrête à
sa première moitié et que les étapes 2 à 4 n'ont rien à montrer.

Le studio local (`http://127.0.0.1:54323`) donne un accès SQL direct pour inspecter le
résultat, et les emails de Supabase Auth sont capturés sur `http://127.0.0.1:54324`.

# Branches

`main` est la production. `develop` est la branche d'intégration : partez d'elle, revenez
vers elle.

```
feature/<sujet>  →  develop  →  main
```

La CI tourne sur les PR vers `main` et `develop`. Une migration n'atteint la production
qu'en passant par `develop`, donc par le job `db-rebuild`.

# Conventions du dépôt

Le code, les commentaires, les messages de commit et la documentation sont en **français**.
Les commentaires expliquent *pourquoi*, pas *quoi* — regardez les en-têtes de
`supabase/migrations/` pour le niveau attendu : contexte, mesure, et ce que la décision
écarte.
