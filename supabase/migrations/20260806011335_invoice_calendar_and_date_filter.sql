-- Rapatriée depuis la base distante (appliquée via le Studio le 2026-08-06, hors dépôt git).
-- Contenu copié à l'identique depuis supabase_migrations.schema_migrations —
-- ne pas modifier : ce fichier documente ce qui est DÉJÀ en production.

drop function if exists public.invoice_list_kpis(text, text, uuid, uuid, boolean, boolean);

create or replace function public.invoice_list_kpis(
  p_query          text    default null,
  p_categorie      text    default null,
  p_commune_id     uuid    default null,
  p_site_id        uuid    default null,
  p_only_anomalies boolean default false,
  p_show_archived  boolean default false,
  p_from           date    default null,
  p_to             date    default null
)
returns table (
  total_count    bigint,
  sum_total_ttc  numeric,
  sum_total_kwh  numeric,
  min_annee      integer,
  max_annee      integer,
  archived_count bigint,
  anomaly_count  bigint
)
language sql
stable
set search_path to ''
as $function$
  with scope as (
    select *
    from public.invoice_analytics v
    where v.org_id = public.current_user_org_id()
  ), filtered as (
    select *
    from scope v
    where (p_show_archived or coalesce(v.archived, false) = false)
      and (p_categorie  is null or v.categorie  = p_categorie)
      and (p_commune_id is null or v.commune_id = p_commune_id)
      and (p_site_id    is null or v.site_id    = p_site_id)
      and (not p_only_anomalies or v.open_anomaly_count > 0)
      and (p_from is null or v.facture_date >= p_from)
      and (p_to   is null or v.facture_date <= p_to)
      and (
        p_query is null or p_query = '' or
        coalesce(v.facture_number, '') ilike '%' || p_query || '%' or
        coalesce(v.site_nom, '')       ilike '%' || p_query || '%' or
        coalesce(v.commune_nom, '')    ilike '%' || p_query || '%'
      )
  )
  select
    (select count(*)                    from filtered),
    (select coalesce(sum(total_ttc), 0) from filtered),
    (select coalesce(sum(total_kwh), 0) from filtered),
    (select min(annee)                  from filtered),
    (select max(annee)                  from filtered),
    (select count(*) from scope where coalesce(archived, false) = true),
    (select count(*) from scope where coalesce(archived, false) = false and open_anomaly_count > 0)
$function$;

grant execute on function public.invoice_list_kpis(text, text, uuid, uuid, boolean, boolean, date, date)
  to authenticated, service_role;

create or replace function public.invoice_calendar_days(
  p_query          text    default null,
  p_categorie      text    default null,
  p_commune_id     uuid    default null,
  p_site_id        uuid    default null,
  p_only_anomalies boolean default false,
  p_show_archived  boolean default false
)
returns table (
  jour      date,
  n         bigint,
  total_ttc numeric
)
language sql
stable
set search_path to ''
as $function$
  select
    v.facture_date as jour,
    count(*)       as n,
    coalesce(sum(v.total_ttc), 0) as total_ttc
  from public.invoice_analytics v
  where v.org_id = public.current_user_org_id()
    and v.facture_date is not null
    and (p_show_archived or coalesce(v.archived, false) = false)
    and (p_categorie  is null or v.categorie  = p_categorie)
    and (p_commune_id is null or v.commune_id = p_commune_id)
    and (p_site_id    is null or v.site_id    = p_site_id)
    and (not p_only_anomalies or v.open_anomaly_count > 0)
    and (
      p_query is null or p_query = '' or
      coalesce(v.facture_number, '') ilike '%' || p_query || '%' or
      coalesce(v.site_nom, '')       ilike '%' || p_query || '%' or
      coalesce(v.commune_nom, '')    ilike '%' || p_query || '%'
    )
  group by v.facture_date
  order by v.facture_date
$function$;

grant execute on function public.invoice_calendar_days(text, text, uuid, uuid, boolean, boolean)
  to authenticated, service_role;
