-- Rollback de 20260806000000_invoice_calendar_and_date_filter.sql
-- Retire l'agrégat calendrier et restaure `invoice_list_kpis` dans sa signature à 6 paramètres.

drop function if exists public.invoice_calendar_days(text, text, uuid, uuid, boolean, boolean);

drop function if exists public.invoice_list_kpis(text, text, uuid, uuid, boolean, boolean, date, date);

create or replace function public.invoice_list_kpis(
  p_query          text    default null,
  p_categorie      text    default null,
  p_commune_id     uuid    default null,
  p_site_id        uuid    default null,
  p_only_anomalies boolean default false,
  p_show_archived  boolean default false
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

grant execute on function public.invoice_list_kpis(text, text, uuid, uuid, boolean, boolean)
  to authenticated, service_role;
