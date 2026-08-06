-- Rapatriée depuis la base distante (appliquée via le Studio le 2026-08-06, hors dépôt git).
-- Contenu copié à l'identique depuis supabase_migrations.schema_migrations —
-- ne pas modifier : ce fichier documente ce qui est DÉJÀ en production.

revoke execute on function public.invoice_list_kpis(text, text, uuid, uuid, boolean, boolean, date, date)
  from public, anon;

revoke execute on function public.invoice_calendar_days(text, text, uuid, uuid, boolean, boolean)
  from public, anon;
