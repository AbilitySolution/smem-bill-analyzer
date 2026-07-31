# Design — file de traitement multi-documents

**Branche** : `staging` (`0687e84`)
**Périmètre** : import et extraction de plusieurs factures d'électricité en une seule opération.

---

## 1. Choix d'architecture

**Aucune librairie de queue externe.** Ni Celery, ni RQ, ni Bull, ni Redis, ni worker Node dédié.
La file repose entièrement sur la plateforme Supabase :

| Brique | Rôle |
|---|---|
| **pgmq** (extension Postgres) | Transport des messages — ne véhicule qu'un `job_id` |
| **`public.document_jobs`** | État métier, source de vérité |
| **pg_cron** | Déclencheur, toutes les minutes |
| **pg_net** | Appel HTTP de Postgres vers les Edge Functions |
| **Supabase Vault** | Stockage de `project_url` et `service_role_key` pour le Cron |
| **Edge Functions** (Deno) | Workers |
| **Supabase Realtime** | Notification de la progression au navigateur |

Aucune dépendance npm ajoutée pour la file : le `package.json` ne gagne que `jszip`
(import de dossiers/ZIP côté client) et `@anthropic-ai/sdk` passe en `^0.106.0`.

**Le principe directeur** est posé en commentaire de la première migration :
*« Business state lives in public.document_jobs; pgmq only transports job ids. »*
Un message pgmq perdu ne perd donc jamais de données — le job reste en base et reste relançable.

---

## 2. Deux modes de traitement

Le mode est choisi **par l'appelant** à l'import (`processing_mode` dans le `FormData`) et figé
sur le job. La migration `20260718000000` introduit ce routage hybride.

| | **`direct`** | **`batch`** |
|---|---|---|
| API fournisseur | Messages (synchrone) | Message Batches (asynchrone) |
| Passe par pgmq | Non | Oui |
| Worker | `process-direct-documents` | `process-document-queue` + `collect-document-batches` |
| Statuts | `direct_queued` → `direct_processing` → `needs_review` | `queued` → `uploading_to_claude` → `batched` → `needs_review` |
| Réservation | `claim_direct_document_jobs()` (`FOR UPDATE SKIP LOCKED`) | `claim_document_jobs()` (`pgmq.read`) |
| Latence | Quelques secondes | Minutes à heures |
| Coût | Plein tarif | Réduit (tarif batch) |
| Usage visé | Petits imports, retour immédiat | Gros volumes, coût maîtrisé |

---

## 3. Composants

### 3.1 Entrée — `POST /api/document-jobs`

[app/api/document-jobs/route.ts](app/api/document-jobs/route.ts)

Maximum **10 fichiers** par appel, **20 Mo** par fichier.

Contrôles, dans l'ordre :
1. Authentification — cookie de session **ou** `Authorization: Bearer` (le second sert au script de benchmark).
2. `processing_mode` explicitement `direct` ou `batch`, sinon 400.
3. Type MIME dans `application/pdf`, `image/png`, `image/jpeg`, `image/webp`.
4. Taille non nulle et ≤ 20 Mo.
5. **Vérification des magic bytes** ([route.ts:15-22](app/api/document-jobs/route.ts#L15-L22)) — l'en-tête réel du fichier doit correspondre au type déclaré, sinon 415. Bonne défense contre l'upload déguisé.

Puis, par fichier : upload vers le bucket `invoice-files` sous `<user_id>/queue/<job_id>-<nom_assaini>`,
insertion du `document_jobs`, et — en mode `batch` seulement — `rpc('enqueue_document_job')`.

Si l'insertion échoue, le fichier déjà uploadé est **supprimé du storage** ([route.ts:120](app/api/document-jobs/route.ts#L120)) : pas d'orphelin. ✅
Si l'enqueue échoue, le job passe en `failed` avec le message d'erreur — il reste relançable. ✅

Réponse `202 Accepted`.

### 3.2 Worker batch — `process-document-queue`

[supabase/functions/process-document-queue/index.ts](supabase/functions/process-document-queue/index.ts)

Constantes : `BATCH_SIZE = 5`, `MAX_BATCHES_PER_INVOCATION = 10`, `FILE_UPLOAD_CONCURRENCY = 3`,
`QUEUE_VISIBILITY_SECONDS = 180`, `MAX_ATTEMPTS = 3`.

Boucle jusqu'à 10 lots par invocation :

1. `claim_document_jobs()` — lit jusqu'à 5 messages pgmq avec une visibilité de 180 s.
2. Les jobs déjà en `batched` / `needs_review` / `completed` sont **acquittés et ignorés** — garde anti-double-traitement ([index.ts:79-82](supabase/functions/process-document-queue/index.ts#L79-L82)). ✅
3. Passage en `uploading_to_claude`, incrément de `attempt_count`.
4. Upload des fichiers vers l'API Files, **3 en parallèle**. `anthropic_file_id` mémorisé : une relance ne réuploade pas.
5. **Pré-filtrage** (sauf si `skip_prefilter`) — voir §4.
6. Création du lot via `POST /v1/messages/batches`, insertion dans `document_batches`, passage des jobs en `batched`, acquittement des messages pgmq.

### 3.3 Collecteur — `collect-document-batches`

[supabase/functions/collect-document-batches/index.ts](supabase/functions/collect-document-batches/index.ts)

Traite jusqu'à 10 lots `in_progress` en parallèle (`Promise.allSettled`).
Interroge le statut ; tant que `processing_status !== 'ended'`, met seulement à jour `request_counts`
et ressort. Une fois terminé : téléchargement du JSONL, une ligne par job, `custom_id` = `document_jobs.id`.

Par ligne : extraction du bloc `tool_use`, contrôle de la présence des 6 clés obligatoires
(`client`, `contract`, `invoice`, `fixed_charges`, `consumption_lines`, `taxes`), puis passage en
`needs_review` avec l'`extraction_json`. En cas d'échec : `failed` + `last_error`.

Dans tous les cas, le fichier distant est supprimé (`deleteDocument`) et `anthropic_file_id` remis à `NULL`.
✅ Pas de fuite de fichiers côté fournisseur.

### 3.4 Worker direct — `process-direct-documents`

[supabase/functions/process-direct-documents/index.ts](supabase/functions/process-direct-documents/index.ts)

`MAX_JOBS = 10`, `CONCURRENCY = 3`, `MAX_ATTEMPTS = 3`.

Réserve via `claim_direct_document_jobs()` — un `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)`
qui passe atomiquement les jobs en `direct_processing` et incrémente `attempt_count`. Deux invocations
concurrentes ne peuvent pas réserver le même job. ✅

Appelable de deux façons :
- **Par le Cron** — `Authorization: Bearer <service_role_key>`, `ownerId = null`, traite tous les jobs en attente.
- **Par un utilisateur** — jeton utilisateur, `ownerId` renseigné, `claim_direct_document_jobs` filtre alors sur `created_by`. Permet le déclenchement immédiat sans attendre le tick suivant. ✅ Bonne conception.

Tous les `UPDATE` de fin sont conditionnés par `.eq("status", "direct_processing")`
([index.ts:122](supabase/functions/process-direct-documents/index.ts#L122), [L132](supabase/functions/process-direct-documents/index.ts#L132), [L145](supabase/functions/process-direct-documents/index.ts#L145)) :
un job relancé entre-temps n'est pas écrasé. ✅ Verrouillage optimiste correct.

### 3.5 Sauvegarde automatique — `POST /api/document-jobs/auto-save`

[app/api/document-jobs/auto-save/route.ts](app/api/document-jobs/auto-save/route.ts)

Seuil unique : **`AUTO_THRESHOLD = 0.96`**, appliqué **conjointement** à la confiance d'extraction
et au score de rapprochement de commune. Les deux doivent être ≥ 96 %.

Trois issues par job :
- **`autoSaved`** — les deux scores au-dessus du seuil : facture créée, job en `completed`.
- **`duplicates`** — `/api/invoices` renvoie 409 : le job est fermé en pointant vers la facture existante, sans doublon créé. ✅
- **`toReview`** — sinon, révision manuelle, avec la meilleure commune pré-remplie même sous le seuil. ✅ Bon détail ergonomique.

⚠️ L'enregistrement passe par un `fetch` HTTP interne vers `${origin}/api/invoices` en réinjectant
le cookie de l'appelant ([route.ts:83-92](app/api/document-jobs/auto-save/route.ts#L83-L92)). Cela réutilise
toute la logique de validation existante — l'intention est bonne — mais c'est fragile : dépendance à
`request.url.origin` (proxy, rewrite, déploiement multi-domaine) et un aller-retour réseau par facture.
**Recommandation** : extraire la logique de `/api/invoices` dans une fonction partagée et l'appeler directement.

---

## 4. Pré-filtrage

Migration `20260720000000`. Avant l'extraction complète, une classification à un tour sur
**une page unique** avec un modèle bon marché (`AI_MODEL_PREFILTER`, `max_tokens: 60`) décide si le
document est bien une facture d'électricité individuelle.

Sinon : statut `rejected_non_invoice`, `prefilter_type` ∈ `facture` | `bordereau_recapitulatif` | `autre`,
fichier distant supprimé, extraction complète jamais payée.

**Biais volontaire vers l'acceptation** : si le classifieur échoue ou renvoie une réponse invalide,
l'exception est avalée et le document part en extraction normale
([process-document-queue/index.ts:115-118](supabase/functions/process-document-queue/index.ts#L115-L118),
[process-direct-documents/index.ts:38-41](supabase/functions/process-direct-documents/index.ts#L38-L41)).
✅ Le bon arbitrage : une panne du pré-filtre coûte de l'argent, elle ne perd pas de document.

Un rejet à tort est rattrapable : `retry_document_job` positionne `skip_prefilter = true` et force
l'extraction, une seule fois.

---

## 5. Gestion des erreurs et des relances

### Classification des erreurs

[supabase/functions/_shared/ai-client.ts](supabase/functions/_shared/ai-client.ts)

`RETRYABLE_STATUSES` = `408, 409, 429, 500, 502, 503, 504, 529`.
`isRetryableProcessingError()` renvoie `true` par défaut quand aucun code n'est identifiable —
biais vers la relance plutôt que vers l'abandon. ✅

Deux niveaux de retry :
1. **Dans `aiRequest`** — jusqu'à 3 tentatives, uniquement sur `429` et `529`, backoff 1 s puis 3 s.
2. **Au niveau du job** — `MAX_ATTEMPTS = 3`. Au-delà, ou sur erreur non retryable, statut terminal `failed`.

### Assainissement des messages

[lib/ai/error.ts](lib/ai/error.ts) et [supabase/functions/_shared/ai-error.ts](supabase/functions/_shared/ai-error.ts)

`toUserSafeError()` renvoie `{ userMessage, logMessage }` : le nom du fournisseur est retiré du message
utilisateur, le détail brut reste côté serveur. Les erreurs de crédit/facturation sont remplacées par un
message générique. `last_error` est tronqué à 1000 caractères avant écriture en base. ✅
C'est la partie la mieux testée du diff (11 des 15 tests).

### Reprise après incident

- Message pgmq non acquitté → redevient visible après 180 s → rejoué. ✅
- Le job reste en base quoi qu'il arrive : jamais de perte silencieuse. ✅
- Sur erreur terminale en mode batch, le message est acquitté pour ne pas boucler indéfiniment
  ([index.ts:151](supabase/functions/process-document-queue/index.ts#L151)). ✅

---

## 6. Flux complet

```
Navigateur — /upload
  │  10 fichiers max, 20 Mo max
  ▼
POST /api/document-jobs          auth → MIME → magic bytes → taille
  │  Storage: invoice-files/<user_id>/queue/<job_id>-<nom>
  │  INSERT document_jobs
  ├──────────────── mode = direct ────────────────┐
  │                                               │
  │ mode = batch                                  │ status = direct_queued
  │ rpc enqueue_document_job                      │
  │ pgmq.send('document_ocr', {job_id})           │
  ▼                                               ▼
pg_cron (* * * * *) ──pg_net──►            pg_cron / appel direct utilisateur
 process-document-queue                     process-direct-documents
  │                                               │
  │ claim_document_jobs (5)                       │ claim_direct_document_jobs
  │ upload fichiers (×3 //)                       │   FOR UPDATE SKIP LOCKED
  │ pré-filtre ─── non-facture ──► rejected       │ upload + pré-filtre (×3 //)
  │ POST /v1/messages/batches                     │ POST /v1/messages
  │ status = batched                              │ status = needs_review
  ▼                                               │
pg_cron (* * * * *) ──pg_net──►                   │
 collect-document-batches                         │
  │ GET /v1/messages/batches/{id}                 │
  │ si ended → GET .../results (JSONL)            │
  │ status = needs_review                         │
  ▼                                               ▼
        Supabase Realtime ──► /upload (progression temps réel)
                     │
                     ▼
  POST /api/document-jobs/auto-save    seuil 0,96 (extraction ET commune)
        ├── auto-enregistrée ─► invoices (auto_saved = true) ─► completed
        ├── doublon (409) ────► completed, pointe l'existante
        └── à revoir ─────────► /upload/review (commune pré-remplie)
```

---

## 7. Points forts

- **État métier séparé du transport.** Perdre un message pgmq ne perd jamais un document.
- **Verrouillage concurrent correct** dans les deux modes (`SKIP LOCKED` d'un côté, visibilité pgmq de l'autre), plus un verrouillage optimiste sur les écritures finales.
- **Nettoyage systématique** des fichiers distants et des uploads orphelins.
- **Validation des magic bytes** à l'entrée.
- **`SECURITY DEFINER` avec `search_path` figé** et `REVOKE ALL` avant `GRANT` sur toutes les fonctions.
- **Dégradation choisie** : le pré-filtre en panne laisse passer plutôt que de bloquer.
- **Instrumentation de bout en bout** (`queued_at` → `result_available_at`) permettant de mesurer chaque étape.

## 8. Réserves

| Sujet | Détail | Gravité |
|---|---|---|
| **Couverture de tests** | Aucun test sur l'orchestration : réservation, retry, transitions de statut, RLS, routes API. Les 15 tests portent sur l'assainissement d'erreurs et la formulation des prompts. | 🟠 Élevée |
| **RLS `document_batches`** | Tout compte authentifié lit tous les lots (§2.2 de l'audit). | 🟠 Moyenne |
| **`fetch` interne auto-save** | Dépendance à `request.url.origin` + un aller-retour réseau par facture. | 🟡 Moyenne |
| **Échec Cron silencieux** | Secrets Vault absents ⇒ aucun appel, aucune alerte. | 🟡 Moyenne |
| **CI sans tests** | `.github/workflows/build.yml` lance `npm ci` et `npm run build`, **pas `npm test`**. Et ne se déclenche pas sur `main`. | 🟡 Moyenne |
| **`proxy.ts`** | `/api/document-jobs` retiré du garde d'authentification global. La route refait bien le contrôle (401), et seul le chemin exact est exempté — `/[id]` et `/auto-save` restent protégés. Acceptable, mais la sécurité ne repose plus que sur le handler. | 🟡 Faible |
| **Fonction morte** | `claim_document_job(integer)` (singulier) n'a plus d'appelant. | 🟢 Cosmétique |
| **Compatibilité multi-tenant** | `document_jobs` n'a pas d'`org_id` alors que la prod isole par organisation. **Voir `MIGRATION_AUDIT.md` §4.4 — bloquant.** | 🔴 Bloquante |
