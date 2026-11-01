-- One active computer per account. The newest sign-in takes the slot; the older
-- device notices on its next heartbeat and signs itself out. No cross-device
-- push is attempted: this is what keeps two machines from editing the same
-- windows without a real-time channel.
create table if not exists public.nanfu_active_device (
  user_id uuid primary key references auth.users (id) on delete cascade,
  device_id text not null check (char_length(device_id) between 8 and 64),
  session_id uuid not null,
  signed_in_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table public.nanfu_active_device enable row level security;

revoke all on table public.nanfu_active_device from anon;
grant select, insert, update, delete on table public.nanfu_active_device to authenticated;

drop policy if exists nanfu_active_device_select on public.nanfu_active_device;
create policy nanfu_active_device_select
  on public.nanfu_active_device for select to authenticated
  using (user_id = auth.uid());

drop policy if exists nanfu_active_device_insert on public.nanfu_active_device;
create policy nanfu_active_device_insert
  on public.nanfu_active_device for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists nanfu_active_device_update on public.nanfu_active_device;
create policy nanfu_active_device_update
  on public.nanfu_active_device for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists nanfu_active_device_delete on public.nanfu_active_device;
create policy nanfu_active_device_delete
  on public.nanfu_active_device for delete to authenticated
  using (user_id = auth.uid());

create index if not exists nanfu_active_device_seen_idx
  on public.nanfu_active_device (last_seen_at desc);
