# Rollbacks

Un fichier par migration, à exécuter **dans l'ordre inverse** de l'application. Ces
fichiers ne sont pas des migrations : ils ne sont pas joués par `supabase db push` et
n'apparaissent pas dans l'historique. On les exécute à la main (`psql`, éditeur SQL du
studio) en cas de retour arrière.

| Ordre | Fichier | Effet | Destructif ? |
|---|---|---|---|
| 1 | `20260805000001_drop_extraction_batches_down.sql` | Recrée `extraction_batches` / `extraction_batch_items` (vides) | Non, mais les lots perdus ne reviennent pas |
| 2 | `20260805000000_document_queue_down.sql` | Supprime la file, les 5 fonctions, les 3 Cron, `document_batches`, `invoices.auto_saved` | 🔴 **Perte totale de la file** |

## Règles impératives

1. **Désactiver les Cron en premier.** Sinon `net.http_post` continue de frapper des
   Edge Functions qui écrivent dans des tables disparues :

   ```sql
   SELECT cron.unschedule(jobid) FROM cron.job
   WHERE jobname IN ('dispatch-claude-batches','collect-claude-batches','process-direct-documents');
   ```

2. **Vidanger la file avant tout `DROP`.** Un `document_jobs` non terminal au moment de
   la suppression = document perdu pour l'utilisateur, avec un fichier orphelin dans le
   bucket `invoice-files`. Contrôle préalable :

   ```sql
   SELECT status, count(*) FROM public.document_jobs
   WHERE status NOT IN ('completed','failed','rejected_non_invoice')
   GROUP BY status;
   ```

   Doit renvoyer 0 ligne.

3. **Les lots Anthropic en vol survivent au rollback.** Un `document_batches` supprimé
   côté base laisse le lot tourner chez le fournisseur. Les annuler explicitement
   (`POST /v1/messages/batches/{id}/cancel`) ou les laisser expirer avant de dérouler.

4. **`invoices.auto_saved` est le seul retrait à risque nul** s'il est joué seul :
   additif, isolé, aucune dépendance. Il est inclus dans le rollback 2 ; l'en tête si
   la colonne doit être conservée pour l'historique.
