-- ============================================================
-- RugRadar — Supabase Database Schema
-- Copy & paste this into Supabase → SQL Editor → Run
-- ============================================================

-- 1. USERS TABLE
-- Stores every person who signs up
create table if not exists users (
  id uuid default gen_random_uuid() primary key,
  email text unique not null,
  plan text default 'free' check (plan in ('free', 'pro', 'whale')),
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  scans_today integer default 0,
  scan_date date default current_date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 2. SCAN HISTORY TABLE
-- Every token scan ever run — users can look back at their history
create table if not exists scans (
  id uuid default gen_random_uuid() primary key,
  user_email text references users(email) on delete set null,
  address text not null,
  chain text not null,
  chain_name text,
  token_name text,
  token_symbol text,
  risk_level text check (risk_level in ('LOW', 'MEDIUM', 'HIGH')),
  risk_score integer,
  flags jsonb default '[]',
  safe_checks jsonb default '[]',
  market_data jsonb,
  sources jsonb,
  scanned_at timestamptz default now()
);

-- 3. WATCHLIST TABLE  
-- Tokens users save to monitor for risk changes
create table if not exists watchlist (
  id uuid default gen_random_uuid() primary key,
  user_email text references users(email) on delete cascade,
  address text not null,
  chain text not null,
  token_name text,
  token_symbol text,
  last_risk_level text,
  last_risk_score integer,
  last_checked timestamptz,
  added_at timestamptz default now(),
  unique(user_email, address, chain)
);

-- 4. INDEXES for fast lookups
create index if not exists idx_users_email on users(email);
create index if not exists idx_users_stripe on users(stripe_customer_id);
create index if not exists idx_scans_email on scans(user_email);
create index if not exists idx_scans_address on scans(address);
create index if not exists idx_watchlist_email on watchlist(user_email);

-- 5. AUTO-UPDATE updated_at on users
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger users_updated_at
  before update on users
  for each row execute function update_updated_at();

-- 6. ROW LEVEL SECURITY (keeps data safe)
alter table users enable row level security;
alter table scans enable row level security;
alter table watchlist enable row level security;

-- Allow your backend (service role) to do everything
-- Your frontend should NEVER touch the DB directly

-- ============================================================
-- Done! Your database is ready.
-- ============================================================
