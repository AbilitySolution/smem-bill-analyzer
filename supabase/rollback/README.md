# Rollbacks

Un fichier par migration, à exécuter **dans l'ordre inverse** de l'application. Ces
fichiers ne sont pas des migrations : ils ne sont pas joués par `supabase db push` et
n'apparaissent pas dans l'historique. On les exécute à la main (`psql`, éditeur SQL du
studio) en cas de retour arrière.

| Ordre | Fichier | Effet | Destructif ? |
|---|---|---|---|
| −6 | `20260820010000_reconcile_prod_schema_down.sql` | Ramène `pending_uploads` à `processed boolean`, relâche les 18 `NOT NULL`, restaure les noms hérités de `invoice_consumption_lines` et l'index de date en ASC | 🔴 **Remet le bug d'origine.** Trois chemins de code lisent `pending_uploads.status` : sans redéploiement d'une version antérieure du code, la page « Demandes de fichier » retombe en panne. Les états `processing` / `error` retombent sur `processed = false` et sont perdus |
| −5 | `20260820000000_anomalies_refonte_down.sql` | Restaure le `CHECK` à seize valeurs sur `anomalies.type` | 🟠 Partiel — restaure la contrainte, pas les lignes supprimées ; détail en tête du fichier |
| −4 | `20260819000000_user_roles_three_tiers_down.sql` | Rétrograde les superviseurs en membres, restaure le `CHECK` à deux valeurs, retire le défaut `org_member`, `is_org_supervisor()` et le verrou « dernier administrateur » | 🟠 Partiel — la distinction Superviseur/Membre est perdue et non reconstituable ; **relever la liste des `org_supervisor` avant d'exécuter** |
| −3 | `20260817044616_postgrest_table_grants_down.sql` | Retire uniquement les privilèges par défaut : les tables futures n'héritent plus des droits PostgREST | 🔴 **Ne pas jouer sur la prod.** Le retrait des droits sur les tables existantes est commenté à dessein — il couperait l'application (403 sur toute l'API) |
| −2 | `20260817042337_communes_creation_down.sql` | Retire `archived`, remet `code_insee` à NULL et facultatif, restaure les coordonnées d'avant SCRUM-14 | 🟠 Partiel — perd l'état d'archivage et le `code_insee` des communes créées depuis, et **réintroduit des coordonnées fausses de plus de 10 km** sur Case Pilote, Ducos et Le Marigot |
| −1b | `20260817032642_collect_batches_sub_minute_down.sql` | Repasse la collecte des lots Claude de 20 s à une fois par minute. **Ne retire pas** le bail sur `list_batches_to_collect`, conservé à dessein | Non — les factures remontent jusqu'à 40 s plus tard, aucun lot perdu |
| −1 | `20260806000006_invoice_analytics_total_anomaly_count_down.sql` | Retire `anomaly_count` de la vue (DROP + recréation) | Non — mais l'Historique de /anomalies reperd les factures entièrement résolues |
| 0 | `20260806000005_queue_health_and_leak_fix_down.sql` | Retire les fonctions de santé de la file ; `retry_document_job` recommence à détruire le pointeur du fichier distant | Non — mais 🔴 rétablit la fuite de PDF chez le fournisseur |
| 0b | `20260806000004_org_scoped_anomaly_recompute_down.sql` | Le recalcul d'anomalies retransporte les identifiants dans l'URL | Non — mais replafonne à ~200 factures/org |
| 1 | `20260806000003_auto_save_server_side_down.sql` | Retire le balayage Cron de l'enregistrement automatique | Non — mais il redevient dépendant d'un onglet ouvert |
| 2 | `20260806000002_bigger_batches_down.sql` | Lots de 5 documents, collecte FIFO sans équité | Non — mais collecte ~10× plus lente |
| 3 | `20260806000001_fair_dispatch_down.sql` | Recrée la file pgmq et les 3 fonctions associées, retire le tourniquet | Non — mais rétablit le couplage entre clients |
| 4 | `20260806000000_org_scoped_dispatch_down.sql` | Supprime `claim_org_document_jobs` et son index | Non — mais rouvre le dispatch global aux appels utilisateur |
| 5 | `20260805000001_drop_extraction_batches_down.sql` | Recrée `extraction_batches` / `extraction_batch_items` (vides) | Non, mais les lots perdus ne reviennent pas |
| 6 | `20260805000000_document_queue_down.sql` | Supprime la file, les 5 fonctions, les 3 Cron, `document_batches`, `invoices.auto_saved` | 🔴 **Perte totale de la file** |

> Chacun des rollbacks 1 à 3 exige de redéployer d'abord le code correspondant (tâche
> planifiée, Edge Functions) — détail en tête de chaque fichier.

> Le rollback 1 **doit** être précédé du redéploiement de `process-document-queue` en
> version pgmq, et il ré-enfile lui-même les jobs `queued` restants — sans quoi ils ne
> repartent jamais. Détail en tête du fichier.

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
