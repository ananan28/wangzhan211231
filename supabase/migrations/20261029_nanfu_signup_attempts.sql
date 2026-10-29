-- Rolling per-address throttle for website registration.
--
-- One row per accepted attempt; the nanfu-signup Edge Function keeps at most
-- five rows per client address in the last hour. Service-role only, exactly
-- like the release table. Re-runnable.

begin;

create table if not exists public.nanfu_signup_attempts (
  ip text not null,
  at timestamptz not null default now()
);

create index if not exists nanfu_signup_attempts_ip_at_idx
  on public.nanfu_signup_attempts (ip, at desc);

alter table public.nanfu_signup_attempts enable row level security;

grant select, insert, delete on public.nanfu_signup_attempts to service_role;

commit;
