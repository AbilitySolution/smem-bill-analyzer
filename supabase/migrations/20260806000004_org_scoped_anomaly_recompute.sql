-- ===== RECALCUL D'ANOMALIES : NE PLUS TRANSPORTER LES IDENTIFIANTS =====
--
-- `recomputeAndPersistAnomalies` chargeait tous les identifiants de factures de
-- l'organisation, puis les réinjectait dans trois requêtes via `.in("invoice_id", …)`.
-- Avec supabase-js, `.in(…)` n'est pas un corps de requête : la liste part dans la
-- **chaîne de requête de l'URL**, à 37 octets par facture.
--
--   200 factures  →  7,7 Ko d'URL
--   500 factures  → 19,2 Ko
--   1 000 factures → 38,2 Ko
--
-- L'URL fait partie de la ligne de requête HTTP, que les proxys plafonnent (8 Ko pour
-- la valeur nginx par défaut). Au-delà : 414 ou 400, et la fonction lève.
--
-- Deux choses aggravent le tableau :
--   - le compteur porte sur le TOTAL de factures de l'organisation, pas sur un dépôt ;
--     il ne redescend jamais ;
--   - `selectAll` pagine la *réponse* par tranches de 1000, mais chaque requête réémet
--     la liste complète — la pagination est du mauvais côté.
--
-- Et ce n'est pas qu'un problème de Cron : `saveInvoice` appelle ce recalcul dès que
-- `skipPortfolioRecompute` n'est pas posé, donc `/api/invoices` POST aussi — le bouton
-- « Enregistrer » de la page de révision.
--
-- Correctif : les trois requêtes prennent désormais `org_id` et rien d'autre. Les
-- identifiants ne quittent plus la base. Le calcul lui-même reste en TypeScript
-- (`computePortfolioAnomalies`, couvert par des tests) — le porter en SQL serait une
-- réécriture risquée pour aucun gain ici.

/**
 * Contrôle d'accès commun aux trois fonctions.
 *
 * Elles sont SECURITY DEFINER, donc la RLS ne s'applique plus : sans ce garde-fou, un
 * membre d'une organisation pourrait lire — et surtout SUPPRIMER — les anomalies d'une
 * autre en passant simplement son `org_id`. Le service-role (Cron, scripts) reste libre.
 */
CREATE OR REPLACE FUNCTION public.assert_org_access(target_org uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF target_org IS NULL THEN
    RAISE EXCEPTION 'target_org is required';
  END IF;
  IF auth.role() <> 'service_role' AND target_org <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_org_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_org_access(uuid) TO authenticated, service_role;

/**
 * Périodes de consommation des factures actives d'une organisation.
 *
 * Pagination par arguments explicites plutôt que par en-tête `Range` : le comportement
 * de `Range` sur un appel RPC dépend de PostgREST, autant ne pas en dépendre sur un
 * chemin critique. Le tri est indispensable — une pagination sans ordre total peut
 * renvoyer deux fois la même ligne ou en sauter.
 */
CREATE OR REPLACE FUNCTION public.org_anomaly_periods(
  target_org uuid,
  page_limit integer DEFAULT 1000,
  page_offset integer DEFAULT 0
)
RETURNS TABLE(
  invoice_id       uuid,
  period_start     date,
  period_end       date,
  consommation_kwh numeric,
  montant_eur      numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.assert_org_access(target_org);
  RETURN QUERY
  SELECT periods.invoice_id, periods.period_start, periods.period_end,
         periods.consommation_kwh, periods.montant_eur
  FROM public.consumption_periods AS periods
  JOIN public.invoices AS invoice ON invoice.id = periods.invoice_id
  WHERE invoice.org_id = target_org
    AND invoice.archived = false
  ORDER BY periods.invoice_id, periods.id
  LIMIT GREATEST(page_limit, 1) OFFSET GREATEST(page_offset, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.org_anomaly_periods(uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.org_anomaly_periods(uuid, integer, integer) TO authenticated, service_role;

/**
 * Anomalies recalculables déjà en base, pour conserver le statut `resolved` de celles
 * qui réapparaissent à l'identique — sinon un recalcul rouvrirait ce qu'un utilisateur
 * a déjà traité.
 */
CREATE OR REPLACE FUNCTION public.org_recomputed_anomalies(
  target_org uuid,
  anomaly_types text[],
  page_limit integer DEFAULT 1000,
  page_offset integer DEFAULT 0
)
RETURNS TABLE(invoice_id uuid, type text, resolved boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.assert_org_access(target_org);
  RETURN QUERY
  SELECT anomaly.invoice_id, anomaly.type, anomaly.resolved
  FROM public.anomalies AS anomaly
  JOIN public.invoices AS invoice ON invoice.id = anomaly.invoice_id
  WHERE invoice.org_id = target_org
    AND invoice.archived = false
    AND anomaly.type = ANY(anomaly_types)
  ORDER BY anomaly.invoice_id, anomaly.type
  LIMIT GREATEST(page_limit, 1) OFFSET GREATEST(page_offset, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.org_recomputed_anomalies(uuid, text[], integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.org_recomputed_anomalies(uuid, text[], integer, integer) TO authenticated, service_role;

/**
 * Purge des anomalies recalculables avant réinsertion.
 *
 * `archived = false` reproduit exactement le périmètre d'origine : la liste
 * d'identifiants transportée jusqu'ici ne contenait que des factures actives. Le
 * comportement est donc inchangé — on ne corrige ici qu'une limite de transport.
 *
 * À noter au passage, sans le changer : les anomalies recalculables d'une facture
 * archivée après coup ne sont jamais purgées, puisqu'elle sort du périmètre. Décision
 * produit, pas technique.
 */
CREATE OR REPLACE FUNCTION public.delete_org_recomputed_anomalies(target_org uuid, anomaly_types text[])
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count bigint;
BEGIN
  PERFORM public.assert_org_access(target_org);
  WITH removed AS (
    DELETE FROM public.anomalies AS anomaly
    USING public.invoices AS invoice
    WHERE invoice.id = anomaly.invoice_id
      AND invoice.org_id = target_org
      AND invoice.archived = false
      AND anomaly.type = ANY(anomaly_types)
    RETURNING anomaly.id
  )
  SELECT count(*) INTO deleted_count FROM removed;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_org_recomputed_anomalies(uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_org_recomputed_anomalies(uuid, text[]) TO authenticated, service_role;

-- Les jointures ci-dessus remontent toutes de `anomalies`/`consumption_periods` vers
-- `invoices`. Sans ces index, chaque recalcul balaie les tables entières.
CREATE INDEX IF NOT EXISTS idx_anomalies_invoice_type
  ON public.anomalies(invoice_id, type);
CREATE INDEX IF NOT EXISTS idx_consumption_periods_invoice
  ON public.consumption_periods(invoice_id);
