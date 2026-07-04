-- Energie Documents — extension multi-communes du schéma smem-bill-analyzer
-- Ajoute : communes, sites (Bâtiment / Éclairage public), tags, activités,
-- liens "demande de fichier", rôles utilisateurs (admin SMEM / agent commune),
-- et le scoping RLS associé. N'altère aucune donnée existante.

-- ===== COMMUNES =====
create table if not exists communes (
  id uuid primary key default gen_random_uuid(),
  nom text not null unique,
  code_insee text,
  created_at timestamptz default now()
);

-- ===== SITES (PDL) : Bâtiment ou Éclairage public, rattaché à une commune =====
create table if not exists sites (
  id uuid primary key default gen_random_uuid(),
  commune_id uuid references communes(id) on delete cascade not null,
  categorie text not null check (categorie in ('batiment','eclairage_public')),
  nom text not null,
  pdl text,
  kva numeric,
  ampere numeric,
  created_at timestamptz default now()
);

create index if not exists idx_sites_commune on sites(commune_id);

-- ===== Rattachements (denormalisation pour requêtes/RLS simples) =====
alter table contracts add column if not exists site_id uuid references sites(id);
alter table clients add column if not exists commune_id uuid references communes(id);
alter table invoices add column if not exists commune_id uuid references communes(id);
alter table invoices add column if not exists site_id uuid references sites(id);
alter table invoices add column if not exists categorie text check (categorie in ('batiment','eclairage_public'));

create index if not exists idx_contracts_site on contracts(site_id);
create index if not exists idx_invoices_commune on invoices(commune_id);
create index if not exists idx_invoices_site on invoices(site_id);

-- ===== TAGS (étiquettes de statut, façon Odoo Documents) =====
create table if not exists tags (
  id uuid primary key default gen_random_uuid(),
  label text not null unique,
  color text not null default 'gray',
  created_at timestamptz default now()
);

create table if not exists invoice_tags (
  invoice_id uuid references invoices(id) on delete cascade,
  tag_id uuid references tags(id) on delete cascade,
  primary key (invoice_id, tag_id)
);

insert into tags (label, color) values
  ('À vérifier', 'amber'),
  ('Validée', 'green'),
  ('Anomalie', 'red'),
  ('Duplicata', 'gray')
on conflict (label) do nothing;

-- ===== ACTIVITÉS / NOTES INTERNES =====
create table if not exists activities (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('invoice','contract','site','commune')),
  entity_id uuid not null,
  author_id uuid references auth.users(id),
  body text not null,
  created_at timestamptz default now()
);

create index if not exists idx_activities_entity on activities(entity_type, entity_id);

-- ===== DEMANDE DE FICHIER (lien d'upload public par commune) =====
create table if not exists file_request_links (
  id uuid primary key default gen_random_uuid(),
  commune_id uuid references communes(id) on delete cascade not null,
  token text not null unique default encode(gen_random_bytes(16), 'hex'),
  label text,
  created_by uuid references auth.users(id),
  expires_at timestamptz,
  created_at timestamptz default now()
);

-- ===== RÔLES UTILISATEURS =====
create table if not exists user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin_smem','agent_commune')),
  commune_id uuid references communes(id),
  created_at timestamptz default now()
);

-- ===== HELPERS RLS (security definer pour éviter la récursion sur user_roles) =====
create or replace function current_user_role()
returns text language sql stable security definer as $$
  select role from user_roles where user_id = auth.uid()
$$;

create or replace function current_user_commune_id()
returns uuid language sql stable security definer as $$
  select commune_id from user_roles where user_id = auth.uid()
$$;

create or replace function is_admin_smem()
returns boolean language sql stable security definer as $$
  select coalesce((select role from user_roles where user_id = auth.uid()) = 'admin_smem', false)
$$;

-- ===== RLS : nouvelles tables =====
alter table communes enable row level security;
alter table sites enable row level security;
alter table tags enable row level security;
alter table invoice_tags enable row level security;
alter table activities enable row level security;
alter table file_request_links enable row level security;
alter table user_roles enable row level security;

create policy "scoped_select_communes" on communes
  for select using (is_admin_smem() or id = current_user_commune_id());
create policy "admin_write_communes" on communes
  for all using (is_admin_smem()) with check (is_admin_smem());

create policy "scoped_select_sites" on sites
  for select using (is_admin_smem() or commune_id = current_user_commune_id());
create policy "admin_write_sites" on sites
  for all using (is_admin_smem()) with check (is_admin_smem());

create policy "authenticated_read_tags" on tags
  for select using (auth.role() = 'authenticated');
create policy "admin_write_tags" on tags
  for all using (is_admin_smem()) with check (is_admin_smem());

create policy "scoped_invoice_tags" on invoice_tags
  for all using (
    is_admin_smem() or invoice_id in (
      select id from invoices where commune_id = current_user_commune_id()
    )
  ) with check (
    is_admin_smem() or invoice_id in (
      select id from invoices where commune_id = current_user_commune_id()
    )
  );

create policy "scoped_activities" on activities
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "scoped_file_request_links" on file_request_links
  for all using (is_admin_smem() or commune_id = current_user_commune_id())
  with check (is_admin_smem() or commune_id = current_user_commune_id());

create policy "self_read_user_roles" on user_roles
  for select using (user_id = auth.uid() or is_admin_smem());
create policy "admin_write_user_roles" on user_roles
  for all using (is_admin_smem()) with check (is_admin_smem());

-- ===== RLS : rescoper les tables existantes par commune =====
drop policy if exists "authenticated_full_access" on clients;
create policy "scoped_clients" on clients
  for all using (is_admin_smem() or commune_id = current_user_commune_id())
  with check (is_admin_smem() or commune_id = current_user_commune_id());

drop policy if exists "authenticated_full_access" on contracts;
create policy "scoped_contracts" on contracts
  for all using (
    is_admin_smem() or site_id in (select id from sites where commune_id = current_user_commune_id())
  ) with check (
    is_admin_smem() or site_id in (select id from sites where commune_id = current_user_commune_id())
  );

drop policy if exists "authenticated_full_access" on invoices;
create policy "scoped_invoices" on invoices
  for all using (is_admin_smem() or commune_id = current_user_commune_id())
  with check (is_admin_smem() or commune_id = current_user_commune_id());

drop policy if exists "authenticated_full_access" on consumption_periods;
create policy "scoped_consumption_periods" on consumption_periods
  for all using (
    is_admin_smem() or invoice_id in (select id from invoices where commune_id = current_user_commune_id())
  ) with check (
    is_admin_smem() or invoice_id in (select id from invoices where commune_id = current_user_commune_id())
  );

drop policy if exists "authenticated_full_access" on invoice_charges;
create policy "scoped_invoice_charges" on invoice_charges
  for all using (
    is_admin_smem() or invoice_id in (select id from invoices where commune_id = current_user_commune_id())
  ) with check (
    is_admin_smem() or invoice_id in (select id from invoices where commune_id = current_user_commune_id())
  );

drop policy if exists "authenticated_full_access" on anomalies;
create policy "scoped_anomalies" on anomalies
  for all using (
    is_admin_smem() or invoice_id in (select id from invoices where commune_id = current_user_commune_id())
  ) with check (
    is_admin_smem() or invoice_id in (select id from invoices where commune_id = current_user_commune_id())
  );

drop policy if exists "authenticated_full_access" on corrections_log;
create policy "scoped_corrections_log" on corrections_log
  for all using (
    is_admin_smem() or invoice_id in (select id from invoices where commune_id = current_user_commune_id())
  ) with check (
    is_admin_smem() or invoice_id in (select id from invoices where commune_id = current_user_commune_id())
  );
