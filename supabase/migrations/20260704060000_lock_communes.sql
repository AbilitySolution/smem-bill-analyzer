-- Communes = liste fixe des 20 communes SMEM.
-- On retire le droit d'INSERT même pour admin_smem.
-- Seuls UPDATE (modifier points_lumineux, travaux…) et DELETE restent.
-- Les seeds passent en superuser (migrations) et contournent RLS.

DROP POLICY IF EXISTS "admin_write_communes" ON communes;

CREATE POLICY "admin_update_communes" ON communes
  FOR UPDATE USING (is_admin_smem()) WITH CHECK (is_admin_smem());

CREATE POLICY "admin_delete_communes" ON communes
  FOR DELETE USING (is_admin_smem());
