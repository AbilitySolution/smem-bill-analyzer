# Audit des migrations Supabase — `staging` → `main`

**Date** : 2026-07-30
**Branche source** : `staging` (`0687e84`)
**Branche cible** : `main`
**Projet prod** : `nymorbhybxkhcyatguzl` (smem-bill-analyzer, ca-central-1, ACTIVE_HEALTHY)
**Projet staging** : `hfihvslrzmlukpjjxdmy` (smem-bill-analyzer-staging, us-west-2)

**Verdict : 🔴 MERGE BLOQUÉ.** 4 blocants, détaillés en §4.

---

## 1. Inventaire des migrations ajoutées

6 fichiers ajoutés dans `supabase/migrations/`, aucun fichier existant modifié.

| # | Fichier | Objet |
|---|---------|-------|
| 1 | `20260715000000_document_queue.sql` | Table `document_jobs`, file pgmq `document_ocr`, 4 fonctions, Cron |
| 2 | `20260715010000_claude_batches.sql` | Table `document_batches`, orchestration Batch API |
| 3 | `20260715020000_fix_pgmq_send_column_reference.sql` | Correctif `pgmq.send()` (42703) |
| 4 | `20260718000000_hybrid_document_processing.sql` | Mode hybride direct/batch + instrumentation |
| 5 | `20260720000000_document_prefilter.sql` | Pré-filtrage Haiku (rejet non-factures) |
| 6 | `20260720120000_auto_saved_invoices.sql` | `invoices.auto_saved` |

---

## 2. Détail par migration

### 2.1 `20260715000000_document_queue.sql`

**Extensions** : `pgmq`, `pg_cron`, `pg_net` (toutes en `IF NOT EXISTS`).

**Table `public.document_jobs`** — 19 colonnes, PK `uuid` / `gen_random_uuid()`.

| Contrainte | Détail | Verdict |
|---|---|---|
| FK `created_by` → `auth.users(id)` | `ON DELETE CASCADE` | ✅ Cohérent : suppression compte = purge des jobs |
| FK `suggested_commune_id` → `communes(id)` | `ON DELETE SET NULL` | ✅ |
| FK `suggested_site_id` → `sites(id)` | `ON DELETE SET NULL` | ✅ |
| FK `processed_invoice_id` → `invoices(id)` | `ON DELETE SET NULL` | ✅ |
| CHECK `file_size` | `> 0 AND <= 20971520` (20 Mo) | ✅ Aligné sur `MAX_FILE_SIZE` de la route API |
| CHECK `status` | 5 valeurs | ⚠️ Réécrit 3× par les migrations suivantes |
| CHECK `attempt_count >= 0` | | ✅ |

**Index** : `(created_by, created_at DESC)` et `(status, created_at)`. ✅ Couvrent les deux accès réels (liste utilisateur, balayage worker).

**Nommage** : `snake_case`, préfixe `idx_<table>_<colonnes>`, policies en clair. ✅ Conforme au reste du schéma (`20260704050000_squash.sql`).

**RLS** : activée. Une seule policy, `owners_read_document_jobs` (SELECT). Aucune policy INSERT/UPDATE/DELETE → écritures impossibles pour `authenticated`, réservées au `service_role` qui contourne la RLS. ✅ Intentionnel et correct : les routes API écrivent via `createAdminClient()`.

**Fonctions** (toutes `SECURITY DEFINER` avec `SET search_path` explicite ✅) :

| Fonction | Grants | Verdict |
|---|---|---|
| `enqueue_document_job(uuid)` | `authenticated`, `service_role` | ✅ Contrôle propriétaire interne |
| `retry_document_job(uuid)` | `authenticated`, `service_role` | ✅ Idem + garde sur statut |
| `claim_document_job(integer)` | `service_role` uniquement | ⚠️ Morte dès la migration 2 (voir §3.4) |
| `acknowledge_document_job(bigint)` | `service_role` uniquement | ✅ |

`REVOKE ALL ... FROM PUBLIC` systématique avant `GRANT`. ✅ Bonne pratique respectée.

**⚠️ Non-idempotent** : ligne 158, `ALTER PUBLICATION supabase_realtime ADD TABLE public.document_jobs;` échoue en `42710` si rejouée. Tout le reste du fichier est `IF NOT EXISTS` / `CREATE OR REPLACE`. À encadrer d'un `DO $$ ... EXCEPTION WHEN duplicate_object` si le fichier doit être rejouable.

**Cron** : job `process-document-ocr-queue` toutes les minutes, lit `project_url` et `service_role_key` depuis `vault.decrypted_secrets`. Si les secrets sont absents, les sous-requêtes ne renvoient aucune ligne → `net.http_post` n'est jamais appelé, échec **silencieux**. Documenté dans le README, mais aucune alerte : voir monitoring en §6 de `MERGE_REPORT.md`.

### 2.2 `20260715010000_claude_batches.sql`

- `status` étendu à 7 valeurs (`uploading_to_claude`, `batched` ajoutés). Le `DROP CONSTRAINT IF EXISTS` puis `ADD CONSTRAINT` est correct ; toutes les valeurs préexistantes restent valides. ✅
- Colonnes `anthropic_file_id`, `anthropic_batch_id` (`text`, nullable). ✅
- **Table `document_batches`** : `anthropic_batch_id` `UNIQUE NOT NULL` ✅, CHECK `document_count > 0` ✅.
- **⚠️ RLS `document_batches`** : `FOR SELECT USING (auth.role() = 'authenticated')` → **tout utilisateur connecté lit tous les lots**, y compris ceux des autres. Pas de PII (compteurs, horodatages, id Anthropic), donc fuite mineure — mais incohérent avec l'isolation par utilisateur de `document_jobs`, et franchement incompatible avec le modèle multi-tenant en prod (§4.1). À reprendre.
- `claim_document_jobs(integer, integer)` : borne `LEAST(GREATEST(message_limit,1),10)` ✅ ; visibilité plancher 60 s ✅.
- Cron : remplace le job unique par `dispatch-claude-batches` + `collect-claude-batches`. La boucle `unschedule` couvre les 3 noms possibles ✅ idempotent.

### 2.3 `20260715020000_fix_pgmq_send_column_reference.sql`

Correctif : `pgmq.send()` en 1.5.1 renvoie `SETOF bigint` sans nom de colonne ; le code référençait `msg_id` → `42703` à chaque enqueue.

✅ Le correctif est **également rétro-intégré** dans les migrations 1 et 2 (vérifié : `20260715000000` l.75 et `20260715010000` l.76 utilisent bien `SELECT * INTO message_id`). Un environnement neuf ne rencontre donc jamais le bug, et cette migration est un no-op sur une base fraîche. ✅ Bonne pratique.

⚠️ Le commentaire d'en-tête cite en clair la référence du projet staging (`hfihvslrzmlukpjjxdmy`). Non sensible (une ref projet n'est pas un secret), mais autant ne pas la figer dans le SQL.

### 2.4 `20260718000000_hybrid_document_processing.sql`

- 6 colonnes d'instrumentation + `benchmark_run_id`. Nommage `<étape>_at` cohérent ✅.
- **⚠️ `queued_at timestamptz NOT NULL DEFAULT now()`** : sur une table non vide, toutes les lignes existantes sont backfillées à l'instant de la migration, pas à leur vraie date de mise en file. Les mesures de latence sur l'historique antérieur sont donc fausses. Impact nul en prod (table inexistante), à connaître pour l'interprétation des benchmarks staging.
- `processing_mode text NOT NULL DEFAULT 'batch'` + CHECK `IN ('direct','batch')` ✅ ordre correct (colonne avant contrainte).
- `status` étendu à 9 valeurs.
- **Index partiels** bien ciblés : `idx_document_jobs_direct_pending` (`WHERE processing_mode='direct' AND status='direct_queued'`) et `idx_document_jobs_benchmark_run` (`WHERE benchmark_run_id IS NOT NULL`). ✅ Excellent choix, très sélectifs.
- `claim_direct_document_jobs()` : CTE + `FOR UPDATE SKIP LOCKED` + `UPDATE ... RETURNING`. ✅ Verrouillage concurrent correct, pas de double-traitement possible entre invocations parallèles.

### 2.5 `20260720000000_document_prefilter.sql`

- `prefilter_type text` + CHECK `IS NULL OR IN ('facture','bordereau_recapitulatif','autre')` ✅ (le `IS NULL OR` est nécessaire et présent).
- `skip_prefilter boolean NOT NULL DEFAULT false` ✅.
- `status` étendu à 10 valeurs (`rejected_non_invoice`).
- `retry_document_job` : `skip_prefilter = skip_prefilter OR was_rejected` — un job rejeté à tort relancé force l'extraction. ✅ Logique correcte et non destructive.

### 2.6 `20260720120000_auto_saved_invoices.sql`

`invoices.auto_saved boolean NOT NULL DEFAULT false` + `COMMENT ON COLUMN`. ✅ Migration la plus simple, additive, sans risque. Seule des 6 à toucher une table préexistante.

---

## 3. Observations transverses

### 3.1 Réécritures en cascade de `document_jobs_status_check`

La contrainte est supprimée/recréée dans 3 migrations sur 6 (2, 4, 5). Le résultat final est correct, mais l'état intermédiaire n'est lisible qu'en rejouant toute la séquence. **Recommandation** : à la prochaine consolidation, remplacer par un `ENUM` ou une table de référence `document_job_statuses`.

### 3.2 `retry_document_job` redéfinie 4 fois

Migrations 1, 2, 3, 4 et 5 la redéfinissent (5 versions au total). Chaque `CREATE OR REPLACE` conserve la même signature `(uuid) RETURNS bigint` ✅ donc pas de fonction orpheline. Version finale = celle de la migration 5. Correct mais coûteux à auditer.

### 3.3 `search_path` figé

Toutes les fonctions `SECURITY DEFINER` fixent `SET search_path = public, pgmq` (ou `public`). ✅ Protection contre le détournement par `search_path` — conforme aux recommandations Supabase.

### 3.4 Fonction morte

`claim_document_job(integer)` (singulier, migration 1) est remplacée par `claim_document_jobs(integer, integer)` (pluriel, migration 2) mais jamais supprimée. Aucun appelant dans le code. **Recommandation** : `DROP FUNCTION public.claim_document_job(integer);` dans une migration de nettoyage.

---

## 4. 🔴 Blocants

### 4.1 BLOQUANT — `is_admin_smem()` n'existe plus en production

Les migrations 1, 2, 3 et 5 référencent `public.is_admin_smem()` :

- `20260715000000` l.46 — dans la policy RLS `owners_read_document_jobs`
- `20260715000000` l.71, l.103 — corps de `enqueue_document_job` / `retry_document_job`
- `20260715010000` l.67, `20260715020000` l.26/47, `20260720000000` l.44

**Vérifié en production** — fonctions présentes dans le schéma `public` :

```
current_user_org_id()
is_org_admin()
match_commune(input_text text, p_org_id uuid)
```

`is_admin_smem()` est **absente**. La migration `20260729000000_multi_tenant` (appliquée en prod, voir §4.2) l'a remplacée par `is_org_admin()`, a renommé les rôles (`admin_smem` → `org_admin`, `agent_commune` → `org_member`) et a supprimé `match_commune(text)` au profit de `match_commune(text, uuid)`.

**Conséquence** : `CREATE POLICY` résout les fonctions à la création. `supabase db push` sur la prod **échoue immédiatement** en `42883 function public.is_admin_smem() does not exist`, sur la toute première migration de la série. Les corps plpgsql échoueraient eux à l'exécution.

### 4.2 BLOQUANT — divergence de l'historique de migrations prod / dépôt

| Version | Nom | prod | staging (DB) | `main` (git) | `staging` (git) |
|---|---|:--:|:--:|:--:|:--:|
| 20260704050000 | squash | ✅ | ✅ | ✅ | ✅ |
| 20260704060000 | lock_communes | ✅ | ✅ | ✅ | ✅ |
| 20260705000000 | fix_anomaly_types | ✅ | ✅ | ✅ | ✅ |
| **20260706000000** | **custom_fields** | ✅ | ❌ | ❌ | ❌ |
| 20260715000000 | document_queue | ❌ | ✅ | ❌ | ✅ |
| 20260715010000 | claude_batches | ❌ | ✅ | ❌ | ✅ |
| 20260715020000 | fix_pgmq_send | ❌ | ✅ | ❌ | ✅ |
| 20260718000000 | hybrid_processing | ❌ | ✅ | ❌ | ✅ |
| 20260720000000 / 20260721020846 | document_prefilter | ❌ | ✅ | ❌ | ✅ |
| 20260720120000 / 20260721000552 | auto_saved_invoices | ❌ | ✅ | ❌ | ✅ |
| **20260728000000** | **communes-latlng** | ✅ | ❌ | ❌ | ❌ |
| **20260729000000** | **multi_tenant** | ✅ | ❌ | ❌ | ❌ |
| **20260731000000** | **anomaly_types** | ✅ | ❌ | ❌ | ❌ |

Trois problèmes distincts :

1. **La prod contient 4 migrations absentes de `main` et de `staging`** (`custom_fields`, `communes-latlng`, `multi_tenant`, `anomaly_types`). Elles existent en git, mais seulement sur des branches jamais mergées (`aff9946`, `e93ae99`, `e808687`, `0c8c134` — branches `feature/ajout_champs_custom`, `feature/detection_anomalies`, etc.). **`main` n'est donc pas la source de vérité de la production.** `supabase db push` détectera un historique distant plus avancé que le local et refusera de continuer sans `migration repair`.

2. **Application dans le désordre.** Les 6 nouvelles migrations sont horodatées 2026-07-15 → 2026-07-20, alors que la prod a déjà appliqué 2026-07-28, -29 et -31. Les appliquer telles quelles insère des versions antérieures au dernier état appliqué — accepté par la CLI seulement avec `--include-all`, et sémantiquement faux ici puisque `multi_tenant` (postérieur) a changé les fondations sur lesquelles ces migrations s'appuient.

3. **Renumérotation après application.** Les mêmes migrations portent des versions différentes en staging (`20260721000552 auto_saved_invoices`, `20260721020846 document_prefilter`) et dans le dépôt (`20260720120000`, `20260720000000`) — avec en prime un **ordre relatif inversé** entre les deux. Les fichiers ont été renommés après coup. Un `db push` sur staging tenterait donc de les rejouer (versions inconnues de l'historique) et casserait sur `ALTER PUBLICATION` (§2.1).

### 4.3 BLOQUANT — aucun plan de rollback

Aucun fichier `down`, `rollback` ou `revert` dans le dépôt (recherche exhaustive hors `node_modules` : 0 résultat). Le README documente le déploiement (`db push`, `functions deploy`, secrets Vault) mais **pas** la marche arrière.

C'est un blocant explicite du cahier des charges. **Un plan de rollback complet et exécutable a été rédigé** : voir `supabase/rollback/` et §5 ci-dessous. Ce point est donc **levable dès relecture et validation du plan fourni**.

### 4.4 BLOQUANT — le code applicatif ignore `org_id`, contrainte `NOT NULL` en prod

Vérifié en production — `org_id` est `NOT NULL`, **sans valeur par défaut ni trigger de peuplement**, sur 10 tables :

```
clients, communes, contracts, custom_field_definitions, file_request_links,
invoices, pending_uploads, sites, tags, user_roles
```

Or `grep -r "org_id|current_user_org_id|is_org_admin|match_commune" --glob *.{ts,tsx}` sur `staging` → **0 résultat**. Aucun code applicatif de `staging` ne renseigne `org_id`.

**Conséquences en prod** :
- Tout `INSERT` dans `invoices` échoue en `23502 null value in column "org_id"`. Cela casse la sauvegarde automatique de la file (`app/api/document-jobs/auto-save/route.ts` → `POST /api/invoices`) **et le flux d'enregistrement manuel existant**.
- `document_jobs` n'a **pas** de colonne `org_id` : sa RLS reste par utilisateur (`created_by = auth.uid()`) alors que le reste du schéma est passé à une isolation par organisation. Deux membres d'une même org partagent leurs factures mais pas leurs jobs — modèle d'isolation incohérent.
- Les appels à `match_commune(text)` (signature à 1 argument) échouent : seule `match_commune(text, uuid)` existe.

**À noter, hors périmètre de ce merge** : ce décalage signifie que la **prod tourne déjà avec une base en avance sur son code applicatif**. `main` ne contient ni `org_id` ni `is_org_admin`. Ce point doit être traité indépendamment et en priorité — voir `MERGE_REPORT.md` §5.

---

## 5. Plan de rollback

Rédigé et livré dans `supabase/rollback/`, un fichier par migration, à exécuter **dans l'ordre inverse**.

| Ordre | Fichier | Effet | Destructif ? |
|---|---|---|---|
| 1 | `20260720120000_auto_saved_invoices_down.sql` | `DROP COLUMN invoices.auto_saved` | ⚠️ Perte du marqueur auto-save |
| 2 | `20260720000000_document_prefilter_down.sql` | Retire `prefilter_type`, `skip_prefilter`, restaure le CHECK à 9 valeurs, restaure `retry_document_job` v4 | ⚠️ Jobs `rejected_non_invoice` à requalifier **avant** |
| 3 | `20260718000000_hybrid_document_processing_down.sql` | Retire les 7 colonnes d'instrumentation, `DROP claim_direct_document_jobs`, unschedule `process-direct-documents` | ⚠️ Perte des métriques ; jobs `direct_*` à migrer **avant** |
| 4 | `20260715020000_fix_pgmq_send_down.sql` | No-op documenté (ne jamais réintroduire le bug) | Non |
| 5 | `20260715010000_claude_batches_down.sql` | `DROP TABLE document_batches`, retire les colonnes `anthropic_*`, unschedule les 2 Cron | ⚠️ Perte de l'historique des lots |
| 6 | `20260715000000_document_queue_down.sql` | `DROP TABLE document_jobs`, `pgmq.drop_queue`, `DROP` des 4 fonctions, unschedule Cron, retire de la publication realtime | 🔴 **Perte totale de la file** |

**Règles impératives** (rappelées en tête de chaque fichier) :

1. **Vidanger la file avant tout rollback.** Un `document_jobs` non terminal au moment du `DROP` = document perdu pour l'utilisateur, avec un fichier orphelin dans le bucket `invoice-files`. Contrôle préalable :
   ```sql
   select status, count(*) from public.document_jobs
   where status not in ('completed','failed','rejected_non_invoice')
   group by status;
   ```
   Doit renvoyer 0 ligne.
2. **Désactiver les Cron en premier**, avant tout `DROP`, sinon `net.http_post` continue de frapper des Edge Functions qui écrivent dans des tables disparues.
3. **Les lots Anthropic en vol survivent au rollback** : un `document_batches` supprimé côté base laisse le batch tourner chez le fournisseur. Les annuler explicitement (`DELETE /v1/messages/batches/{id}/cancel`) ou les laisser expirer avant de dérouler.
4. `invoices.auto_saved` (rollback 1) est **le seul rollback sûr à chaud** : additif, isolé, aucune dépendance.

**Rollback partiel recommandé** : les rollbacks 1 à 5 suffisent à revenir à une file batch simple fonctionnelle. Le rollback 6 n'est justifié que pour un retrait complet de la fonctionnalité.

---

## 6. Synthèse

| Critère | Résultat |
|---|---|
| Syntaxe SQL | ✅ Aucune erreur détectée sur les 6 fichiers |
| Conventions de nommage | ✅ Conformes au schéma existant |
| Clés étrangères et `ON DELETE` | ✅ Toutes cohérentes |
| Index | ✅ Bien ciblés, index partiels pertinents |
| RLS `document_jobs` | ✅ Correcte (lecture propriétaire, écriture service_role) |
| RLS `document_batches` | ⚠️ Lecture ouverte à tout compte authentifié |
| Idempotence | ⚠️ `ALTER PUBLICATION` non rejouable |
| `SECURITY DEFINER` / `search_path` | ✅ Systématiquement verrouillé |
| Plan de rollback | ✅ **Rédigé** (`supabase/rollback/`) — était absent |
| Compatibilité schéma prod | 🔴 **Incompatible** (§4.1, §4.4) |
| Cohérence historique migrations | 🔴 **Divergent** (§4.2) |

**Les migrations sont de bonne facture prises isolément.** Elles sont conçues pour une base au schéma pré-`multi_tenant`, exactement celui de `main` et de la staging. Le problème n'est pas leur qualité intrinsèque : c'est que la production a divergé de `main` par des branches jamais mergées, et que `staging` a été développée sur cette base obsolète.
