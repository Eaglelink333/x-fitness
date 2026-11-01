-- Run once in Supabase → SQL Editor → New query → Run.

create table if not exists public.profile (
  user_id      uuid primary key references auth.users on delete cascade,
  start_weight numeric not null,
  goal_weight  numeric not null,
  height_cm    numeric not null,
  age          int not null,
  sex          text not null check (sex in ('m', 'f')),
  start_date   date not null,
  goal_date    date not null default '2027-01-10',
  name         text
);

-- Added later: safe to re-run on an existing database
alter table public.profile add column if not exists name text;
alter table public.days add column if not exists activities jsonb not null default '[]';
alter table public.profile add column if not exists answers jsonb;
alter table public.profile add column if not exists plan jsonb;
-- Background Apple Health sync: the Shortcut sends this key instead of logging in
alter table public.profile add column if not exists sync_token text unique;
alter table public.profile add column if not exists tz text;

create table if not exists public.days (
  user_id    uuid not null references auth.users on delete cascade,
  date       date not null,
  weight     numeric,
  steps      int,
  active_cal int,
  foods      jsonb not null default '[]',
  activities jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

alter table public.profile enable row level security;
alter table public.days    enable row level security;

-- Dropped first so the whole file is safe to re-run
drop policy if exists "own profile" on public.profile;
drop policy if exists "own days" on public.days;

create policy "own profile" on public.profile
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own days" on public.days
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
