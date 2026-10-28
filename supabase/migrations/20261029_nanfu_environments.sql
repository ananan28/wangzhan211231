-- Nanfu cloud sync schema (Supabase / Postgres).
-- Apply with `supabase db push` or paste into the SQL editor.
--
-- Trust model: the desktop app holds only the public anon key plus the signed-in
-- user's JWT, so row-level security is the only thing separating tenants. The
-- service-role key bypasses RLS and must never be shipped with the app, committed
-- to this repository, or exposed to GitHub Actions logs.

create table if not exists public.nanfu_environments (
  user_id uuid not null references auth.users (id) on delete cascade,
  environment_id text not null check (char_length(environment_id) between 1 and 128),
  -- Monotonic per row: every accepted push stores the next number, so devices
  -- never need synchronized clocks to decide which write is newer.
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  device_id text not null default '',
  -- AES-256-GCM envelope produced on the client; empty for a tombstone.
  payload text not null default '',
  deleted boolean not null default false,
  primary key (user_id, environment_id)
);

create index if not exists nanfu_environments_updated_idx
  on public.nanfu_environments (user_id, updated_at desc);

alter table public.nanfu_environments enable row level security;
alter table public.nanfu_environments force row level security;

revoke all on table public.nanfu_environments from anon;
grant select, insert, update, delete on table public.nanfu_environments to authenticated;

create or replace function public.nanfu_environments_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists nanfu_environments_touch on public.nanfu_environments;
create trigger nanfu_environments_touch
  before insert or update on public.nanfu_environments
  for each row execute function public.nanfu_environments_touch();

drop policy if exists nanfu_environments_select_own on public.nanfu_environments;
create policy nanfu_environments_select_own
  on public.nanfu_environments for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists nanfu_environments_insert_own on public.nanfu_environments;
create policy nanfu_environments_insert_own
  on public.nanfu_environments for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists nanfu_environments_update_own on public.nanfu_environments;
create policy nanfu_environments_update_own
  on public.nanfu_environments for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists nanfu_environments_delete_own on public.nanfu_environments;
create policy nanfu_environments_delete_own
  on public.nanfu_environments for delete to authenticated
  using (auth.uid() = user_id);
