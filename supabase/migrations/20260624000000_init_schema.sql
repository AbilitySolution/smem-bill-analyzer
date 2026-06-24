-- EDF Invoice Analyzer — initial schema

create extension if not exists "pgcrypto";

-- ===== CORE =====
create table clients (
  id uuid primary key default gen_random_uuid(),
  nom text not null,
  reference_client text,
  reference_compte text,
  adresse text,
  created_at timestamptz default now()
);

create table contracts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete cascade,
  contract_number text not null unique,
  espace_livraison text,
  offre text,
  service text,
  puissance_souscrite_kva numeric,
  reglage_protection_a numeric,
  type_compteur text,
  numero_compteur text,
  created_at timestamptz default now()
);

-- ===== INVOICE (header) =====
create table invoices (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid references contracts(id),
  client_id uuid references clients(id),
  facture_number text not null unique,
  facture_date date not null,
  date_limite_paiement date,
  date_prochain_releve date,
  date_prochaine_facture date,
  total_ht numeric not null,
  tva numeric,
  autres_taxes numeric,
  total_ttc numeric not null,
  is_duplicata boolean default false,
  raw_ocr_json jsonb,
  file_path text not null,
  status text not null default 'pending_review'
    check (status in ('pending_review','reviewed','anomaly_flagged')),
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

-- ===== HISTORIQUE CONSOMMATION (tableau aperçu, en-tête facture) =====
create table consumption_history (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references invoices(id) on delete cascade,
  periode_label text not null,
  periode_date date,
  poste_tarifaire text not null,
  valeur_kwh numeric,
  is_estime boolean default false
);

-- ===== PART FIXE (abonnement) =====
create table invoice_fixed_charges (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references invoices(id) on delete cascade,
  libelle text not null,
  date_debut date,
  date_fin date,
  tarif_kva_an numeric,
  montant_eur numeric not null
);

-- ===== PART VARIABLE (consommation, lecture index compteur) =====
create table invoice_consumption_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references invoices(id) on delete cascade,
  poste_tarifaire text not null,
  date_debut date,
  date_fin date,
  numero_compteur text,
  ancien_index numeric,
  nouveau_index numeric,
  coefficient numeric default 1,
  consommation_kwh numeric not null,
  prix_unitaire_ckwh numeric,
  montant_eur numeric not null,
  index_estime boolean default false
);

-- ===== TAXES & CONTRIBUTIONS (détail ligne par ligne) =====
create table invoice_taxes (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references invoices(id) on delete cascade,
  libelle text not null,
  date_debut date,
  date_fin date,
  assiette numeric,
  taux text,
  taux_numeric numeric,
  taux_unit text check (taux_unit in ('eur_per_kwh','percent')),
  montant_eur numeric not null
);

-- ===== CORRECTIONS (audit trail OCR -> manuel) =====
create table corrections_log (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references invoices(id) on delete cascade,
  table_name text not null,
  row_id uuid,
  field_name text not null,
  old_value text,
  new_value text,
  corrected_by uuid references auth.users(id),
  corrected_at timestamptz default now()
);

-- ===== ANOMALIES (analyse) =====
create table anomalies (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references invoices(id) on delete cascade,
  contract_id uuid references contracts(id),
  type text not null check (type in (
    'consumption_spike','missing_period','amount_mismatch','tariff_change'
  )),
  severity text not null default 'medium' check (severity in ('low','medium','high')),
  description text,
  detected_value numeric,
  expected_range_min numeric,
  expected_range_max numeric,
  detected_at timestamptz default now(),
  resolved boolean default false
);

-- ===== INDEXES =====
create index idx_invoices_contract on invoices(contract_id);
create index idx_invoices_facture_date on invoices(facture_date);
create index idx_invoices_status on invoices(status);
create index idx_consumption_history_invoice on consumption_history(invoice_id);
create index idx_consumption_lines_invoice on invoice_consumption_lines(invoice_id);
create index idx_taxes_invoice on invoice_taxes(invoice_id);
create index idx_anomalies_contract on anomalies(contract_id);
create index idx_anomalies_invoice on anomalies(invoice_id);

-- ===== RLS =====
alter table clients enable row level security;
alter table contracts enable row level security;
alter table invoices enable row level security;
alter table consumption_history enable row level security;
alter table invoice_fixed_charges enable row level security;
alter table invoice_consumption_lines enable row level security;
alter table invoice_taxes enable row level security;
alter table corrections_log enable row level security;
alter table anomalies enable row level security;

-- v1: tout utilisateur authentifié accède à tout (mono-org).
-- Passer à scoping par org_id si multi-tenant requis plus tard.
create policy "authenticated_full_access" on clients
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "authenticated_full_access" on contracts
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "authenticated_full_access" on invoices
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "authenticated_full_access" on consumption_history
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "authenticated_full_access" on invoice_fixed_charges
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "authenticated_full_access" on invoice_consumption_lines
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "authenticated_full_access" on invoice_taxes
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "authenticated_full_access" on corrections_log
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "authenticated_full_access" on anomalies
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ===== STORAGE =====
insert into storage.buckets (id, name, public)
values ('invoice-files', 'invoice-files', false)
on conflict (id) do nothing;

create policy "authenticated_read_invoice_files" on storage.objects
  for select using (bucket_id = 'invoice-files' and auth.role() = 'authenticated');
create policy "authenticated_upload_invoice_files" on storage.objects
  for insert with check (bucket_id = 'invoice-files' and auth.role() = 'authenticated');
create policy "authenticated_delete_invoice_files" on storage.objects
  for delete using (bucket_id = 'invoice-files' and auth.role() = 'authenticated');
