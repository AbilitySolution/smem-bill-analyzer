# Rapport de merge — `staging` → `main`

**Date** : 2026-07-31
**Branche source** : `staging` (`0687e84`, à jour avec `origin/staging`)
**Branche cible** : `main`
**Auteur de l'audit** : Claude Opus 5

---

## ⛔ Décision : MERGE NON EXÉCUTÉ

Le merge est **bloqué**. Aucune commande `git merge` n'a été lancée, aucune migration n'a été
appliquée, `main` est inchangée. Les seules écritures réalisées sont les fichiers de documentation
et de rollback listés en §7.

**Motif** : les migrations de `staging` sont **incompatibles avec le schéma réel de la production**.
Elles ne peuvent pas s'appliquer, et le code applicatif de `staging` ne peut pas fonctionner contre
la base de production dans son état actuel.

---

## 1. Grille de validation pré-merge

| # | Critère | Statut |
|---|---|---|
| 1 | Toutes les migrations sont documentées | ✅ `MIGRATION_AUDIT.md` |
| 2 | Les tests passent à 100 % | ✅ 15/15, 4 fichiers, 402 ms |
| 3 | Aucun secret commité | ✅ Vérifié |
| 4 | Un plan de rollback existe | ✅ **Rédigé** (`supabase/rollback/`) — était absent |
| 5 | Compatibilité du schéma de production | 🔴 **ÉCHEC** |
| 6 | Cohérence de l'historique de migrations | 🔴 **ÉCHEC** |
| 7 | Revue de code approuvée | ⬜ À la charge de l'équipe |

Les critères 1 à 4 sont satisfaits. **Les critères 5 et 6 bloquent.**

---

## 2. Tests

```
$ npm test    (vitest 4.1.10)
 Test Files  4 passed (4)
      Tests  15 passed (15)
   Duration  402ms
```

Aucun test échoué, **aucun test ignoré**.

Répartition réelle :

| Fichier | Tests | Objet |
|---|---|---|
| `lib/ai/error.test.ts` | 7 | Assainissement des erreurs fournisseur |
| `supabase/functions/_shared/ai-error.test.ts` | 4 | Idem, côté Edge Functions |
| `lib/anthropic/extract-prompt.test.ts` | 2 | Le prompt ne divulgue pas le fournisseur |
| `supabase/functions/_shared/edf-extraction.test.ts` | 2 | Idem, côté Edge Functions |

⚠️ **La contrainte « les tests passent » est respectée, mais elle ne prouve pas grand-chose ici.**
Les 15 tests couvrent la mise en forme des messages d'erreur et le contenu des prompts. **Zéro test**
sur la file elle-même : réservation concurrente, retry, transitions de statut, RLS, routes API,
sauvegarde automatique. La fonctionnalité livrée n'est pas testée automatiquement.

---

## 3. Secrets

✅ **Aucun secret trouvé.**

- Seul fichier d'environnement suivi par git : `.env.example` — ne contient que des valeurs
  d'exemple (`your-anon-key`, `replace-with-a-staging-only-password`).
- Recherche sur le contenu du diff (`sk-ant-`, JWT `eyJhbGciOi`, `service_role_key=`, mots de passe,
  clés d'API, URLs de projet Supabase) : **0 correspondance**.
- `.gitignore` gagne `env_*.local` — durcissement.
- Les secrets sont correctement externalisés : `Deno.env` pour les Edge Functions,
  Supabase Vault pour le Cron. La migration `20260715000000` commente explicitement que ces valeurs
  ne doivent jamais être placées dans une migration.

Point mineur : `20260715020000_fix_pgmq_send_column_reference.sql` cite en clair la référence du
projet staging (`hfihvslrzmlukpjjxdmy`). Une référence de projet n'est pas un secret, mais autant
ne pas la figer dans le SQL.

---

## 4. Diff `main` → `staging` par catégorie

56 fichiers, **+5420 / −507**. Aucun conflit de merge git (`staging` descend de `main`, merge en
avance rapide possible) — le blocage est **sémantique**, pas textuel.

### Migrations (6 fichiers, +598)
`document_queue`, `claude_batches`, `fix_pgmq_send`, `hybrid_document_processing`,
`document_prefilter`, `auto_saved_invoices`. Détail complet dans `MIGRATION_AUDIT.md`.

### File & workers (11 fichiers, +1200)
3 Edge Functions Deno, 3 modules `_shared`, 3 routes API `/api/document-jobs*`,
`lib/types/document-job.ts`, `lib/document-processing-estimate.ts`.

### Interface (9 fichiers, +1300)
`app/(app)/upload/page.tsx` (+693) et `upload/review`, vue Calendrier (heatmap annuelle),
vue Couverture, navigation Analyses, sidebar.

### Analyses & données (5 fichiers, +400)
`lib/data/consumption.ts` (refonte), `lib/data/coverage.ts` (nouveau), `commune-match.ts`.

### Outillage (5 fichiers, +240)
Script de benchmark, SQL de benchmark, résultats du 2026-07-18, `README.md` (+104).

### Fichiers sensibles modifiés

| Fichier | Changement | Évaluation |
|---|---|---|
| `proxy.ts` | `/api/document-jobs` ajouté aux chemins publics | ⚠️ Le garde d'authentification global ne s'applique plus. La route refait le contrôle et renvoie 401 ; seul le chemin exact est exempté (`/[id]` et `/auto-save` restent protégés). Justifié par l'authentification par jeton Bearer du script de benchmark. **Acceptable, à documenter.** |
| `supabase/config.toml` | `verify_jwt = true` sur les 3 fonctions | ✅ Bon réglage |
| `.gitignore` | `env_*.local` | ✅ Durcissement |
| `.env.example` | 5 variables de benchmark | ✅ Valeurs factices |
| `tsconfig.json` | `supabase/functions` exclu | ✅ Nécessaire (Deno ≠ Node) |
| `.github/workflows/build.yml` | Nouveau | ⚠️ Lance `npm ci` + `npm run build`, **pas `npm test`**. Ne se déclenche pas sur `main`. |
| `package.json` | `+jszip`, `@anthropic-ai/sdk` → `^0.106.0` | ✅ Aucune dépendance de queue externe |

---

## 5. 🔴 Blocants

### 5.1 `is_admin_smem()` n'existe plus en production

Quatre migrations de `staging` référencent `public.is_admin_smem()` — dont la policy RLS
`owners_read_document_jobs`, résolue dès le `CREATE POLICY`.

Fonctions réellement présentes en production (`nymorbhybxkhcyatguzl`) :

```
current_user_org_id()
is_org_admin()
match_commune(input_text text, p_org_id uuid)
```

`is_admin_smem()` a été supprimée par la migration `20260729000000_multi_tenant`, appliquée en
production. **`supabase db push` échouera en `42883` dès la première migration de la série.**

### 5.2 L'historique de migrations a divergé

La production a appliqué **4 migrations absentes de `main` comme de `staging`** :

| Version | Nom | Présente sur |
|---|---|---|
| `20260706000000` | custom_fields | `feature/ajout_champs_custom` uniquement |
| `20260728000000` | communes-latlng | branche de feature uniquement |
| `20260729000000` | multi_tenant | branche de feature uniquement |
| `20260731000000` | anomaly_types | `feature/detection_anomalies` uniquement |

**`main` n'est pas la source de vérité de la production.** Des branches de feature ont été appliquées
directement en base sans jamais être mergées. Conséquences :

1. `supabase db push` détecte un historique distant en avance sur le local et refuse de continuer
   sans `supabase migration repair`.
2. Les 6 nouvelles migrations sont horodatées 2026-07-15 → 07-20, alors que la production a déjà
   appliqué 07-28, 07-29 et 07-31. Application **dans le désordre**, et sémantiquement fausse :
   `multi_tenant` (postérieure) a changé les fondations sur lesquelles elles s'appuient.
3. Les mêmes migrations portent des versions différentes en staging (`20260721000552`,
   `20260721020846`) et dans le dépôt (`20260720120000`, `20260720000000`), avec un **ordre relatif
   inversé** : les fichiers ont été renommés après application.

### 5.3 Le code applicatif ignore `org_id`, `NOT NULL` en production

`org_id` est `NOT NULL`, **sans valeur par défaut ni trigger**, sur 10 tables de production :
`clients`, `communes`, `contracts`, `custom_field_definitions`, `file_request_links`, `invoices`,
`pending_uploads`, `sites`, `tags`, `user_roles`.

Or **aucun fichier `.ts`/`.tsx` de `staging` ne mentionne `org_id`** (0 résultat).

- Tout `INSERT` dans `invoices` échoue en `23502` — ce qui casse la sauvegarde automatique de la file
  **et le flux d'enregistrement manuel existant**.
- `document_jobs` n'a pas d'`org_id` : isolation par utilisateur, alors que le reste du schéma isole
  par organisation. Modèle incohérent.
- Les appels à `match_commune(text)` échouent : seule la signature à 2 arguments existe.

### 5.4 Le plan de rollback était absent — désormais fourni

Aucun fichier `down`/`rollback` n'existait. **6 fichiers de rollback ont été rédigés**
(`supabase/rollback/`), avec les contrôles préalables, l'ordre d'exécution et les avertissements
sur les opérations destructives. **Ce blocant est levé sous réserve de relecture par l'équipe.**

---

## 6. ⚠️ Hors périmètre, mais prioritaire

**La production tourne avec une base de données en avance sur son code applicatif.**

`multi_tenant` a été appliquée en production le 2026-07-29 : rôles renommés (`admin_smem` → `org_admin`),
`org_id NOT NULL` sur 10 tables, RLS entièrement réécrite. Mais `main` — la branche de production —
ne contient **ni** `org_id`, **ni** `is_org_admin`, **ni** la signature à 2 arguments de `match_commune`.

Si le code déployé en production correspond à `main`, alors la création de factures y est
**déjà cassée**, indépendamment de ce merge. **À vérifier en priorité, avant toute autre action.**

### 🔴 Alerte sécurité indépendante

L'analyseur Supabase remonte une alerte **critique** sur la production :

> `public.organizations` — Row Level Security **désactivée** (1 ligne).
> La table est entièrement exposée aux rôles `anon` et `authenticated` : toute personne disposant
> de la clé anon peut lire ou modifier chaque ligne.

Sans rapport avec ce merge, mais à traiter sans délai. Correctif proposé par Supabase :

```sql
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
```

⚠️ **Ne pas appliquer tel quel** : activer la RLS sans policy bloque tout accès à la table.
Définir les policies d'abord, puis activer. C'est une décision d'équipe, pas un correctif automatique.

---

## 7. Fichiers produits

Documentation et rollback uniquement — **aucune modification du code applicatif, aucune opération git**.

| Fichier | Contenu |
|---|---|
| `MIGRATION_AUDIT.md` | Audit des 6 migrations, table de divergence prod/staging/git, 4 blocants, plan de rollback |
| `QUEUE_DESIGN.md` | Architecture de la file, 2 modes, composants, flux, points forts et réserves |
| `MERGE_REPORT.md` | Ce document |
| `supabase/rollback/README.md` | Ordre d'exécution et contrôles préalables |
| `supabase/rollback/*_down.sql` | 6 scripts de rollback, un par migration |

---

## 8. Remise en état — plan proposé

Rien ne doit être mergé avant d'avoir traité les points 1 à 3.

### Étape 0 — Vérifier l'état réel de la production *(immédiat)*
Le code déployé correspond-il à `main` ? Si oui, la création de factures est probablement déjà cassée
(§6). Vérifier avant tout le reste. Traiter par ailleurs l'alerte RLS sur `organizations`.

### Étape 1 — Réconcilier `main` avec la production *(prérequis absolu)*
Rapatrier dans `main` les 4 migrations appliquées en production mais restées sur des branches de
feature (`custom_fields`, `communes-latlng`, `multi_tenant`, `anomaly_types`) **avec leur code
applicatif**. Tant que `main` ne reflète pas la production, aucun merge n'est sûr.

### Étape 2 — Rebaser la file sur le schéma multi-tenant
1. Remplacer tous les appels à `is_admin_smem()` par `is_org_admin()` dans les 4 migrations concernées.
2. Ajouter `org_id uuid NOT NULL REFERENCES organizations(id)` à `document_jobs` et `document_batches`.
3. Réécrire les policies RLS sur `org_id = current_user_org_id()` — et corriger au passage
   la lecture ouverte de `document_batches` (§2.2 de l'audit).
4. Renseigner `org_id` à l'insertion dans les routes API et les Edge Functions.
5. Adapter les appels à `match_commune` à la signature `(text, uuid)`.
6. **Re-horodater les 6 migrations** après `20260731000000` pour rétablir l'ordre chronologique.

### Étape 3 — Rejouer la validation
Base de test neuve à partir de `main` réconciliée, `db push` complet, parcours de bout en bout dans
les deux modes (`direct` et `batch`), test explicite de l'isolation entre deux organisations.

### Étape 4 — Combler les tests
Au minimum : réservation concurrente (`claim_direct_document_jobs` avec `SKIP LOCKED`), transitions
de statut, comportement de retry, isolation RLS. Ajouter `npm test` à `.github/workflows/build.yml`
et déclencher aussi sur `main`.

### Étape 5 — Merger
`git merge --no-ff staging` (pas de squash, historique conservé), puis déploiement dans l'ordre :
`db push` → `functions deploy` → secrets Vault → vérification que les Cron s'exécutent.

---

## 9. Appréciation générale

**Le travail est de bonne qualité.** La file est bien conçue : séparation nette entre état métier et
transport, verrouillage concurrent correct dans les deux modes, nettoyage systématique des fichiers
distants, validation des magic bytes à l'entrée, `SECURITY DEFINER` avec `search_path` verrouillé
partout, et une dégradation bien choisie sur le pré-filtre. Les migrations sont propres et cohérentes
avec les conventions du projet.

**Le problème n'est pas le code de `staging` — c'est le processus autour.** Des branches de feature
ont été appliquées directement en production sans passer par `main`, et `staging` a été développée
pendant ce temps sur une base devenue obsolète. Les deux lignes ont divergé et se sont éloignées en
silence.

La correction est mécanique et sans zone d'ombre, mais elle doit précéder le merge. **La règle à
retenir : plus aucune migration appliquée en production sans passer par `main`.**
