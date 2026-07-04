-- Schema v2: consolidate consumption data into a single fact table
-- (consumption_periods) for clean time-series analysis / anomaly detection.
-- Drops consumption_history (redundant header summary, duplicated other
-- invoices' real data) and merges invoice_fixed_charges + invoice_taxes
-- into invoice_charges (same shape: labeled line, period, amount).

drop table if exists consumption_history;
drop table if exists invoice_fixed_charges;
drop table if exists invoice_taxes;
drop table if exists anomalies;

-- ===== FACT TABLE: one row per billed consumption period =====
alter table invoice_consumption_lines rename to consumption_periods;

alter table consumption_periods rename column date_debut to period_start;
alter table consumption_periods rename column date_fin to period_end;

-- contract_id denormalized onto the fact table so analytics queries don't
-- need to join through invoices for every chart/anomaly scan.
alter table consumption_periods add column contract_id uuid references contracts(id);
update consumption_periods cp
  set contract_id = i.contract_id
  from invoices i
  where i.id = cp.invoice_id;

create index idx_consumption_periods_contract on consumption_periods(contract_id, period_start);

-- ===== BILLING DETAIL: fixed charges + taxes, same shape =====
create table invoice_charges (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references invoices(id) on delete cascade,
  category text not null check (category in ('fixed','tax')),
  libelle text not null,
  period_start date,
  period_end date,
  assiette numeric,           -- base amount taxed/charged (null for simple fixed charges)
  taux text,                  -- raw display value, e.g. "21,93 %" or "0,00936 € / kWh"
  taux_numeric numeric,
  taux_unit text check (taux_unit in ('eur_per_kwh','percent')),
  montant_eur numeric not null
);

create index idx_invoice_charges_invoice on invoice_charges(invoice_id);

alter table invoice_charges enable row level security;
create policy "authenticated_full_access" on invoice_charges
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ===== ANOMALIES: recreate referencing the fact table =====
create table anomalies (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid references contracts(id),
  consumption_period_id uuid references consumption_periods(id),
  invoice_id uuid references invoices(id),
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

create index idx_anomalies_contract on anomalies(contract_id);

alter table anomalies enable row level security;
create policy "authenticated_full_access" on anomalies
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
