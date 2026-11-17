-- ============================================================================
-- Kawaii Slime Company - Employee Discount & Store Credit Schema
-- Database: Supabase PostgreSQL
-- ============================================================================

-- 1. Settings Table: Employee Discount % and Monthly Store Credit $
create table if not exists public.discount_settings (
  id text primary key default 'default',
  employee_discount_percent numeric not null default 20.00,
  monthly_store_credit_amount numeric not null default 25.00,
  updated_at timestamptz not null default now(),
  updated_by text default 'System'
);

-- Seed initial default settings if not exists
insert into public.discount_settings (id, employee_discount_percent, monthly_store_credit_amount, updated_at, updated_by)
values ('default', 20.00, 25.00, now(), 'System')
on conflict (id) do nothing;

-- 2. Employees Table: Created via /api/employees/create
create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  work_email text not null unique,
  shopify_customer_id text,
  shopify_price_rule_id text,
  discount_code text not null unique,
  discount_percentage numeric not null default 20.00,
  monthly_credit_amount numeric not null default 25.00,
  location_type text not null default 'local' check (location_type in ('local', 'remote')),
  status text not null default 'active' check (status in ('active', 'inactive', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3. Employee Discounts Table: Tracks active employees, unique discount codes, Shopify customer & discount IDs
create table if not exists public.employee_discounts (
  id uuid primary key default gen_random_uuid(),
  employee_name text not null,
  work_email text not null unique,
  slack_user_id text,
  shopify_customer_id text,
  shopify_discount_id text,
  discount_code text not null unique,
  discount_percent numeric not null default 20.00,
  total_credit_issued numeric not null default 0.00,
  last_credit_issued_at timestamptz,
  status text not null default 'Active' check (status in ('Active', 'Revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 4. Store Credit Logs Table: Full audit trail of every credit transaction
create table if not exists public.store_credit_logs (
  id uuid primary key default gen_random_uuid(),
  employee_discount_id uuid references public.employee_discounts(id) on delete set null,
  employee_name text not null,
  work_email text not null,
  amount numeric not null,
  reason text not null default 'Monthly Employee Store Credit',
  shopify_transaction_id text,
  status text not null default 'Success' check (status in ('Success', 'Failed')),
  error_message text,
  created_at timestamptz not null default now()
);

-- 5. Slack-Email 4-Digit DM Login Codes Table
create table if not exists public.discount_login_codes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code_hash text not null,
  slack_user_id text,
  slack_user_name text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- 6. Performance Indexes
create index if not exists idx_employees_email on public.employees(work_email);
create index if not exists idx_employees_code on public.employees(discount_code);
create index if not exists idx_employees_status on public.employees(status);
create index if not exists idx_employee_discounts_email on public.employee_discounts(work_email);
create index if not exists idx_employee_discounts_code on public.employee_discounts(discount_code);
create index if not exists idx_employee_discounts_status on public.employee_discounts(status);
create index if not exists idx_store_credit_logs_email on public.store_credit_logs(work_email);
create index if not exists idx_store_credit_logs_created on public.store_credit_logs(created_at desc);
create index if not exists idx_discount_login_codes_lookup on public.discount_login_codes(email, expires_at desc);

-- 7. Enable Row Level Security (RLS) on all tables
alter table public.discount_settings enable row level security;
alter table public.employees enable row level security;
alter table public.employee_discounts enable row level security;
alter table public.store_credit_logs enable row level security;
alter table public.discount_login_codes enable row level security;

-- 8. Policies granting complete, error-free access for application services
drop policy if exists "discount_settings_all_access" on public.discount_settings;
drop policy if exists "employees_all_access" on public.employees;
drop policy if exists "employee_discounts_all_access" on public.employee_discounts;
drop policy if exists "store_credit_logs_all_access" on public.store_credit_logs;
drop policy if exists "discount_login_codes_all_access" on public.discount_login_codes;

create policy "discount_settings_all_access"
  on public.discount_settings
  for all
  using (true)
  with check (true);

create policy "employees_all_access"
  on public.employees
  for all
  using (true)
  with check (true);

create policy "employee_discounts_all_access"
  on public.employee_discounts
  for all
  using (true)
  with check (true);

create policy "store_credit_logs_all_access"
  on public.store_credit_logs
  for all
  using (true)
  with check (true);

create policy "discount_login_codes_all_access"
  on public.discount_login_codes
  for all
  using (true)
  with check (true);
