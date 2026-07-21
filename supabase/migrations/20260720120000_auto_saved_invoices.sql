-- Enregistrement automatique : marque les factures créées sans relecture humaine (confiance ≥ 96 %).
-- Sert au badge « à contrôler » dans Mes documents et au rollback (Annuler) après un lot.
alter table invoices
  add column if not exists auto_saved boolean not null default false;

comment on column invoices.auto_saved is
  'true si la facture a été enregistrée automatiquement (haute confiance) sans relecture manuelle.';
