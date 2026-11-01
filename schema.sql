-- Run in Supabase → SQL Editor → New query → Run. Safe to re-run on an existing database.

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

-- Columns added later (after the tables exist, so a fresh database works too)
alter table public.profile add column if not exists name text;
alter table public.profile add column if not exists answers jsonb;
alter table public.profile add column if not exists plan jsonb;
-- Background Apple Health sync: the Shortcut sends this key instead of logging in
alter table public.profile add column if not exists sync_token text unique;
alter table public.profile add column if not exists tz text;
alter table public.profile add column if not exists favorites jsonb;
alter table public.days add column if not exists activities jsonb not null default '[]';
alter table public.days add column if not exists measure jsonb;

alter table public.profile enable row level security;
alter table public.days    enable row level security;

-- Dropped first so the whole file is safe to re-run
drop policy if exists "own profile" on public.profile;
drop policy if exists "own days" on public.days;

create policy "own profile" on public.profile
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own days" on public.days
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Coach chat history, so it follows you between phone and desktop
create table if not exists public.chat (
  user_id    uuid primary key references auth.users on delete cascade,
  messages   jsonb not null default '[]',
  updated_at timestamptz not null default now()
);
alter table public.chat enable row level security;
drop policy if exists "own chat" on public.chat;
create policy "own chat" on public.chat
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Progress photos: a private bucket, each person can only reach their own folder
insert into storage.buckets (id, name, public) values ('progress', 'progress', false) on conflict (id) do nothing;
drop policy if exists "own progress photos" on storage.objects;
create policy "own progress photos" on storage.objects
  for all to authenticated
  using (bucket_id = 'progress' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'progress' and (storage.foldername(name))[1] = auth.uid()::text);
