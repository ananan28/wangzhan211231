-- Published Nanfu desktop installers.
--
-- One row per uploaded artifact and one private storage bucket. The website
-- never reads the table directly: it asks the nanfu-release Edge Function for a
-- short-lived signed URL. Re-runnable: table, index, bucket and grants are all
-- idempotent.

begin;

create table if not exists public.nanfu_releases (
  id uuid primary key default gen_random_uuid(),
  version text not null,
  platform text not null check (platform in ('win-x64','mac-arm','mac-intel')),
  file_name text not null,
  object_key text not null unique,
  byte_size bigint not null check (byte_size > 0),
  sha256 text not null,
  published_at timestamptz not null default now()
);

create index if not exists nanfu_releases_latest_idx
  on public.nanfu_releases (platform, published_at desc);

alter table public.nanfu_releases enable row level security;

-- No anon or authenticated policy on purpose. Downloads are issued by the
-- nanfu-release function, which is the only holder of the service-role key.
grant select, insert, update on public.nanfu_releases to service_role;

insert into storage.buckets (id, name, public)
values ('nanfu-releases', 'nanfu-releases', false)
on conflict do nothing;

commit;
