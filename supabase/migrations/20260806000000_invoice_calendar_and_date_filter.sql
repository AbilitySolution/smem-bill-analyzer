-- Vue Calendrier de /documents.
--
-- 1) `invoice_list_kpis` accepte une plage de dates (p_from / p_to) : sans elle, cliquer une
--    période dans le calendrier filtrerait la liste mais laisserait les KPIs sur le périmètre
--    complet — des totaux faux affichés au-dessus d'une liste filtrée.
-- 2) `invoice_calendar_days` agrège en SQL le nombre de factures et le total TTC par jour.
--    La liste est paginée en base : le client ne voit qu'une page et ne peut donc pas
--    construire lui-même une heatmap annuelle fidèle.
--
-- Les deux fonctions sont SECURITY INVOKER et passent par current_user_org_id() : l'isolation
-- multi-tenant reste celle de la RLS, aucune élévation de privilège ici.

-- ── 1. KPIs : ajout de la plage de dates ─────────────────────────────────────
-- DROP explicite : ajouter des paramètres (même avec DEFAULT) créerait une SURCHARGE et
-- PostgREST ne saurait plus laquelle appeler.
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
    -- Compteurs des bascules : hors filtre archivé/anomalie, pour que les boutons
    -- affichent le nombre réel disponible et non le nombre déjà filtré.
    (select count(*) from scope where coalesce(archived, false) = true),
    (select count(*) from scope where coalesce(archived, false) = false and open_anomaly_count > 0)
$function$;

-- Recréer une fonction lui redonne l'EXECUTE par défaut de PUBLIC : on le retire pour
-- conserver le durcissement de 20260801000006 (sinon `anon` regagne l'accès au RPC).
revoke execute on function public.invoice_list_kpis(text, text, uuid, uuid, boolean, boolean, date, date)
  from public, anon;
grant execute on function public.invoice_list_kpis(text, text, uuid, uuid, boolean, boolean, date, date)
  to authenticated, service_role;

-- ── 2. Agrégat par jour pour la heatmap du calendrier ────────────────────────
-- Volontairement SANS plage de dates : le calendrier doit afficher l'année entière même
-- quand une période est sélectionnée dans la liste (sinon il ne montrerait que le jour cliqué,
-- rendant impossible de choisir une autre période).
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

revoke execute on function public.invoice_calendar_days(text, text, uuid, uuid, boolean, boolean)
  from public, anon;
grant execute on function public.invoice_calendar_days(text, text, uuid, uuid, boolean, boolean)
  to authenticated, service_role;
