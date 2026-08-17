-- SCRUM-14 (lot 1c) — Socle données pour la création de communes.
--
-- Ajoute l'archivage, rend `code_insee` obligatoire et unique par organisation, et
-- réaligne les coordonnées sur le référentiel des 34 communes de Martinique
-- (lib/communes/referentiel-martinique.ts).
--
-- ⚠️ AUCUN NOM N'EST MODIFIÉ, et c'est voulu à deux titres :
--    - `scoreCommune` matche les factures sur le `nom` : renommer « Les Trois Ilets » en
--      « Les Trois-Îlets » changerait le rattachement des factures futures ;
--    - l'orthographe en base n'a aucune importance pour l'outil. Ce qui compte, ce sont
--      les coordonnées et le `code_insee`. Le nom reste ce qu'il est.
--
-- Les valeurs de `code_insee` viennent du COG INSEE 2026. Le rapprochement nom -> code a
-- été produit puis vérifié par `scripts/check-communes-referentiel.ts` : 20/20 appariées,
-- aucun doublon.
--
-- Les `latitude`/`longitude` sont réalignées sur les centroïdes officiels
-- (geo.api.gouv.fr). Celles posées par 20260728000000_communes-latlng.sql s'écartaient de
-- plus de 3 km sur 7 communes et de plus de 10 km sur Case Pilote, Ducos et Le Marigot,
-- dont les points tombaient hors du territoire communal. Elles alimentent le calcul de
-- longueur de nuit et la correction météo : c'est le vrai enjeu de cette migration.

-- 1. Archivage — remplace la suppression, trop dangereuse (CASCADE sur `sites`, §3.4 / D4).
alter table communes add column if not exists archived boolean not null default false;

-- 2. Backfill des 20 communes existantes : code INSEE et coordonnées officielles.
--    Le rapprochement se fait sur le nom exact en base, seule clé disponible avant backfill.
with referentiel (nom_en_base, code_insee, latitude, longitude) as (
  values
    ('Bellefontaine',       '97234', 14.6747,  -61.146),
    ('Carbet',              '97204', 14.7041,  -61.1583),
    ('Case Pilote',         '97205', 14.6594,  -61.1297),
    ('Ducos',               '97207', 14.5785,  -60.9685),
    ('Fonds Saint Denis',   '97208', 14.7228,  -61.1207),
    ('Grand Rivière',       '97211', 14.847,   -61.1836),
    ('Gros Morne',          '97212', 14.7084,  -61.0303),
    ('La Trinité',          '97230', 14.7518,  -60.9469),
    ('Le Marigot',          '97216', 14.7795,  -61.053),
    ('Le Morne Rouge',      '97218', 14.7695,  -61.1217),
    ('Le Morne Vert',       '97233', 14.7046,  -61.1362),
    ('Le Prêcheur',         '97219', 14.8221,  -61.1963),
    ('Le Robert',           '97222', 14.6786,  -60.9243),
    ('Le Vauclin',          '97232', 14.542,   -60.8595),
    ('Les Anses d''Arlet',  '97202', 14.4996,  -61.0736),
    ('Les Trois Ilets',     '97231', 14.5329,  -61.0376),
    ('Macouba',             '97215', 14.8474,  -61.1465),
    ('Saint Esprit',        '97223', 14.5617,  -60.9233),
    ('Sainte Anne',         '97226', 14.4314,  -60.8516),
    ('Sainte Marie',        '97228', 14.773,   -61.0084)
)
update communes c
   set code_insee = r.code_insee,
       latitude   = r.latitude,
       longitude  = r.longitude
  from referentiel r
 where c.nom = r.nom_en_base
   and c.code_insee is null;

-- 3. Garde-fou : plutôt qu'une violation de contrainte cryptique, un message explicite.
--    Se déclenche si une commune inconnue du référentiel existe (autre territoire, autre
--    org, nom saisi entre-temps) — il faut alors compléter le rapprochement à la main.
do $$
declare
  orphelines text;
begin
  select string_agg(nom, ', ' order by nom) into orphelines
    from communes where code_insee is null;

  if orphelines is not null then
    raise exception
      'SCRUM-14 : commune(s) sans code_insee après backfill : %. Lancer scripts/check-communes-referentiel.ts et compléter le rapprochement avant de rejouer cette migration.',
      orphelines;
  end if;
end $$;

-- 4. `code_insee` devient la clé de rapprochement : obligatoire, et unique par organisation.
--    Deux organisations peuvent avoir la même commune, d'où la portée org (§2 Q1 du PLAN).
--
--    C'est la seule contrainte anti-doublon qui compte : le domaine est fermé, toute
--    création vient du référentiel et porte donc un code. Un filet supplémentaire fondé
--    sur le nom normalisé serait redondant — et il imposerait une orthographe dont l'outil
--    n'a que faire.
alter table communes alter column code_insee set not null;

alter table communes add constraint communes_org_code_insee_key unique (org_id, code_insee);

-- 5. Les vues filtrent par org et masquent les archivées.
create index if not exists communes_org_archived_idx on communes (org_id, archived);

comment on column communes.archived is
  'Commune retirée des vues sans être supprimée. Pas de DELETE : sites, file_request_links et pending_uploads sont en ON DELETE CASCADE.';

-- 6. RLS : rien à réécrire. Les policies org_read_communes / org_admin_insert_communes /
--    _update_ / _delete_ portent sur la ligne entière (org_id = current_user_org_id()),
--    elles couvrent donc `archived` sans modification. Vérifié sur prod.
