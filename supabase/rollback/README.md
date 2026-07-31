# Plan de rollback — file de traitement documentaire

Un fichier `*_down.sql` par migration de la série `20260715` → `20260720`.
**Exécuter dans l'ordre inverse des migrations**, c'est-à-dire dans l'ordre numéroté ci-dessous.

| Ordre | Fichier | Annule |
|---|---|---|
| 1 | `20260720120000_auto_saved_invoices_down.sql` | `invoices.auto_saved` |
| 2 | `20260720000000_document_prefilter_down.sql` | Pré-filtrage Haiku |
| 3 | `20260718000000_hybrid_document_processing_down.sql` | Mode direct + instrumentation |
| 4 | `20260715020000_fix_pgmq_send_down.sql` | (no-op documenté) |
| 5 | `20260715010000_claude_batches_down.sql` | Orchestration Batch |
| 6 | `20260715000000_document_queue_down.sql` | File complète |

## Contrôles obligatoires avant tout rollback

### 1. La file doit être vide de jobs en cours

```sql
select status, count(*) from public.document_jobs
where status not in ('completed','failed','rejected_non_invoice')
group by status;
```

**Doit renvoyer 0 ligne.** Sinon : documents perdus pour l'utilisateur et fichiers orphelins
dans le bucket `invoice-files`. Attendre la fin du traitement ou basculer les jobs en `failed`
avec un `last_error` explicite.

### 2. Aucun lot Anthropic en vol

```sql
select anthropic_batch_id, status, document_count, created_at
from public.document_batches where status = 'in_progress';
```

Un lot supprimé côté base continue de tourner chez le fournisseur. Les annuler
(`POST /v1/messages/batches/{id}/cancel`) ou attendre leur expiration.

### 3. Couper les Cron en premier

Systématiquement fait en tête de chaque fichier `_down.sql` concerné. Sans cela,
`net.http_post` continue d'appeler des Edge Functions qui écrivent dans des tables disparues.

### 4. Retirer les Edge Functions

Le SQL ne les supprime pas. Après le rollback 6 :

```bash
npx supabase functions delete process-document-queue   --project-ref <REF>
npx supabase functions delete collect-document-batches --project-ref <REF>
npx supabase functions delete process-direct-documents --project-ref <REF>
```

## Rollback partiel

Les rollbacks **1 à 5** ramènent à une file batch simple et fonctionnelle : c'est le point
d'arrêt recommandé en cas d'incident. Le rollback **6** ne se justifie que pour un retrait
complet de la fonctionnalité.

Le rollback **1** (`auto_saved`) est le seul sûr à chaud : additif, isolé, sans dépendance.
