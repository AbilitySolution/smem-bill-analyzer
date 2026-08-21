-- Suppression du PDL : le champ n'existe pas sur les factures traitées.
--
-- Le schéma prévoyait un « Point De Livraison » (identifiant Enedis du compteur, 14
-- chiffres) sur `contracts` et `sites`. Vérification faite sur le texte réel des factures :
-- aucune occurrence de « PDL », « Point de livraison » ni « PRM ». Le seul nombre à 14
-- chiffres présent est le SIRET d'EDF (55208131723309), identique sur tous les documents.
--
-- Conséquence : les colonnes n'ont jamais été renseignées — 0 contrat sur 105, 0 site sur
-- 21 — et `saveInvoice` y écrivait explicitement NULL. Aucune donnée n'est perdue ici.
--
-- L'identité du compteur est déjà portée par `numero_compteur`, extrait et renseigné sur
-- 732 lignes de consommation sur 742 (98 compteurs distincts). C'est cette clé, et non le
-- PDL, qui permet de suivre un compteur d'une facture à l'autre.

-- La vue expose `co.pdl` : elle doit être recréée avant que la colonne puisse disparaître.
DROP VIEW IF EXISTS public.invoice_analytics;

DROP INDEX IF EXISTS public.idx_contracts_pdl;

ALTER TABLE public.contracts DROP COLUMN IF EXISTS pdl;
ALTER TABLE public.sites     DROP COLUMN IF EXISTS pdl;

-- Recréation à l'identique, `co.pdl` en moins.
CREATE VIEW public.invoice_analytics AS
SELECT i.id,
    i.site_id,
    i.commune_id,
    i.categorie,
    i.facture_date,
    EXTRACT(year FROM i.facture_date)::integer AS annee,
    EXTRACT(month FROM i.facture_date)::integer AS mois,
    i.total_ht,
    i.total_ttc,
    i.tva,
    i.autres_taxes,
    i.status,
    COALESCE(cp.total_kwh, 0::numeric) AS total_kwh,
        CASE
            WHEN COALESCE(cp.total_kwh, 0::numeric) > 0::numeric THEN round(i.total_ttc / cp.total_kwh, 4)
            ELSE NULL::numeric
        END AS cout_par_kwh_eur,
        CASE
            WHEN COALESCE(cp.total_kwh, 0::numeric) > 0::numeric THEN round(i.total_ttc / cp.total_kwh * 100::numeric, 4)
            ELSE NULL::numeric
        END AS cout_par_kwh_cents,
    s.nom AS site_nom,
    com.nom AS commune_nom,
    co.contract_number,
    co.tarif_type,
    co.offre,
    co.puissance_souscrite_kva,
    i.org_id,
    i.facture_number,
    i.is_duplicata,
    i.file_path,
    i.archived,
    i."precision",
    COALESCE(an.open_count, 0::bigint) AS open_anomaly_count,
    COALESCE(an.total_count, 0::bigint) AS anomaly_count
   FROM invoices i
     LEFT JOIN ( SELECT consumption_periods.invoice_id,
            sum(consumption_periods.consommation_kwh) AS total_kwh
           FROM consumption_periods
          GROUP BY consumption_periods.invoice_id) cp ON cp.invoice_id = i.id
     LEFT JOIN ( SELECT anomalies.invoice_id,
            count(*) FILTER (WHERE anomalies.resolved = false) AS open_count,
            count(*) AS total_count
           FROM anomalies
          GROUP BY anomalies.invoice_id) an ON an.invoice_id = i.id
     LEFT JOIN sites s ON s.id = i.site_id
     LEFT JOIN communes com ON com.id = i.commune_id
     LEFT JOIN contracts co ON co.id = i.contract_id;

-- `security_invoker` : la vue applique les RLS de l'appelant, pas celles de son
-- propriétaire. C'était déjà le cas avant cette migration, et ce doit le rester — sans
-- cette option la vue contournerait l'isolation par organisation.
ALTER VIEW public.invoice_analytics SET (security_invoker = true);

-- Droits reproduits à l'identique de l'état antérieur (défaut Supabase sur le schéma
-- public). Cette migration retire une colonne : elle n'a pas à modifier qui accède à quoi,
-- et un GRANT plus étroit serait un changement de comportement déguisé.
GRANT ALL ON public.invoice_analytics TO anon, authenticated, service_role, postgres;
