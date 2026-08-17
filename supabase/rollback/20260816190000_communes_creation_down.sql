-- Rollback de 20260816190000_communes_creation.sql (SCRUM-14, lot 1c)
--
-- 🟠 PERTE DE DONNÉES PARTIELLE — lire jusqu'au bout avant d'exécuter.
--
-- Ce qui est perdu et ne revient pas :
--   - `archived` : on ne saura plus quelles communes avaient été archivées ;
--   - le `code_insee` des communes créées APRÈS la migration (lot 2+), qui resteront
--     en base sans identifiant. Les recréer proprement supposera de rejouer
--     scripts/check-communes-referentiel.ts.
--
-- Ce qui est restauré : les latitude/longitude des 20 communes historiques.
--
-- ⚠️ PRÉREQUIS — dérouler dans cet ordre :
--   1. Redéployer d'abord le code SANS les lots 2 à 4. Les Server Actions
--      createCommune / archiveCommune et les vues qui filtrent `archived = false`
--      échoueraient en « column does not exist » dès la colonne supprimée.
--   2. Contrôler ce qu'on s'apprête à perdre :
--        select nom, code_insee, archived from communes where archived;
--        select nom, code_insee from communes
--         where code_insee not in (select code_insee from ...) -- communes créées depuis
--      Noter le résultat AILLEURS QU'EN BASE avant de continuer.
--
-- Note sur les coordonnées : les valeurs restaurées ci-dessous sont celles posées par
-- 20260728000000_communes-latlng.sql. Elles sont volontairement reprises du fichier de
-- migration plutôt que d'une table de sauvegarde : elles sont déjà versionnées dans git,
-- elles ont été vérifiées identiques à la prod le 2026-08-16, et aucun écran de
-- l'application ne permet de modifier des coordonnées — elles ne peuvent donc pas avoir
-- dérivé entre-temps. Si ce n'est plus vrai le jour du rollback, relever les valeurs
-- réelles AVANT d'exécuter ce fichier.
--
-- 🔴 Ces coordonnées sont FAUSSES de plus de 3 km sur 7 communes et de plus de 10 km sur
--    Case Pilote (en mer), Ducos et Le Marigot. C'est bien la dette que la migration
--    corrigeait : restaurer, c'est la réintroduire dans le calcul de longueur de nuit et
--    la correction météo. Ne rétablir que si le rollback est réellement nécessaire.

-- 1. Contrainte et index ajoutés par la migration.
alter table communes drop constraint if exists communes_org_code_insee_key;
drop index if exists communes_org_archived_idx;

-- 2. `code_insee` redevient facultatif, puis repasse à NULL comme avant la migration.
alter table communes alter column code_insee drop not null;
update communes set code_insee = null;

-- 3. Colonne ajoutée. Le commentaire part avec elle.
alter table communes drop column if exists archived;

-- 4. Coordonnées historiques (cf. 20260728000000_communes-latlng.sql).
update communes set latitude = 14.6667, longitude = -61.1667 where nom = 'Bellefontaine';
update communes set latitude = 14.7167, longitude = -61.1667 where nom = 'Carbet';
update communes set latitude = 14.6167, longitude = -61.2167 where nom = 'Case Pilote';
update communes set latitude = 14.6833, longitude = -60.9833 where nom = 'Ducos';
update communes set latitude = 14.7333, longitude = -61.1167 where nom = 'Fonds Saint Denis';
update communes set latitude = 14.8667, longitude = -61.2167 where nom = 'Grand Rivière';
update communes set latitude = 14.7667, longitude = -61.0167 where nom = 'Gros Morne';
update communes set latitude = 14.7333, longitude = -60.9667 where nom = 'La Trinité';
update communes set latitude = 14.8667, longitude = -61.0167 where nom = 'Le Marigot';
update communes set latitude = 14.7833, longitude = -61.1333 where nom = 'Le Morne Rouge';
update communes set latitude = 14.7167, longitude = -61.1333 where nom = 'Le Morne Vert';
update communes set latitude = 14.8000, longitude = -61.2333 where nom = 'Le Prêcheur';
update communes set latitude = 14.6767, longitude = -60.9367 where nom = 'Le Robert';
update communes set latitude = 14.5500, longitude = -60.8500 where nom = 'Le Vauclin';
update communes set latitude = 14.4967, longitude = -61.0800 where nom = 'Les Anses d''Arlet';
update communes set latitude = 14.5367, longitude = -61.0367 where nom = 'Les Trois Ilets';
update communes set latitude = 14.8667, longitude = -61.1167 where nom = 'Macouba';
update communes set latitude = 14.5533, longitude = -60.9433 where nom = 'Saint Esprit';
update communes set latitude = 14.4333, longitude = -60.8667 where nom = 'Sainte Anne';
update communes set latitude = 14.7833, longitude = -60.9833 where nom = 'Sainte Marie';

-- 5. Contrôle final — doit renvoyer 20 lignes sans code_insee, aucune colonne archived.
--    select count(*) from communes where code_insee is null;
--    select column_name from information_schema.columns
--     where table_name = 'communes' and column_name = 'archived';  -- 0 ligne
