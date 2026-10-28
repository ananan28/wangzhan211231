-- Nanfu cloud schema (Supabase / Postgres).
--
-- ONE file, applied whole: paste this entire file into the Supabase SQL editor
-- (or run `supabase db push`). It is idempotent, so re-running it after an
-- update is safe and always leaves the same final shape.
--
-- Trust model: the desktop app holds only the publishable ("anon") key plus the
-- signed-in user's JWT, so row-level security is the only thing separating
-- tenants. The service-role key bypasses RLS: it must never be shipped with the
-- app, committed to this repository, or exposed to CI logs.
--
-- Tables
--   nanfu_environments    encrypted environment configuration (sync); each row
--                         belongs to an owner, optionally an org group
--   nanfu_transfers       one encrypted environment package from a sender to a
--                         recipient, accepted once, revocable, expiring
--   nanfu_orgs            organization (one per owner account)
--   nanfu_org_roles       role templates: named permission bits
--   nanfu_org_members     identity + role + manager chain + env quota + lock
--   nanfu_org_groups      groups of windows
--   nanfu_org_group_grants  member -> group authorization
--   nanfu_org_invites     single-use invite codes
--   nanfu_env_transfers   pending / accepted / rejected ownership changes
--
-- Updating this file: keep every change in this file. Do not split schema
-- changes into several migrations the operator would have to paste separately.

-- ---------------------------------------------------------------------------
-- 1. Environments (cloud sync of encrypted configuration)
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 2. Transfers (environments handed from one account to another)
-- ---------------------------------------------------------------------------
-- A sender writes one row holding the already-encrypted package. The recipient
-- is identified by email (and pinned to a user id once they accept). The server
-- stores ciphertext only: it can never read the environment, cookies or keys.
--
-- Recipients do not update rows directly: `nanfu_accept_transfer` is the only
-- way to accept, so a recipient cannot rewrite the payload, move the transfer
-- to another account, or resurrect a revoked/expired one.

create table if not exists public.nanfu_transfers (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users (id) on delete cascade,
  sender_email text not null default '' check (char_length(sender_email) <= 320),
  -- Pinned when the recipient accepts; until then the email decides access.
  recipient_id uuid references auth.users (id) on delete set null,
  recipient_email text not null check (char_length(recipient_email) between 3 and 320),
  environment_id text not null check (char_length(environment_id) between 1 and 128),
  environment_name text not null default '' check (char_length(environment_name) <= 200),
  -- AES-256-GCM envelope produced on the sending device. Never plaintext.
  payload text not null check (char_length(payload) between 1 and 8000000),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  constraint nanfu_transfers_accepted_at_matches_status
    check ((status = 'accepted') = (accepted_at is not null)),
  constraint nanfu_transfers_expiry_after_creation check (expires_at > created_at)
);

create index if not exists nanfu_transfers_sender_idx
  on public.nanfu_transfers (sender_id, created_at desc);
create index if not exists nanfu_transfers_recipient_idx
  on public.nanfu_transfers (lower(recipient_email), status, expires_at desc);

alter table public.nanfu_transfers enable row level security;

revoke all on table public.nanfu_transfers from anon;
grant select, insert, update, delete on table public.nanfu_transfers to authenticated;

-- The sender sees what they sent, including its later status.
drop policy if exists nanfu_transfers_select_sender on public.nanfu_transfers;
create policy nanfu_transfers_select_sender
  on public.nanfu_transfers for select to authenticated
  using (sender_id = auth.uid());

-- A recipient sees only their own still-pending, unexpired transfer. After
-- acceptance it disappears from this view; the sender keeps the receipt.
drop policy if exists nanfu_transfers_select_recipient on public.nanfu_transfers;
create policy nanfu_transfers_select_recipient
  on public.nanfu_transfers for select to authenticated
  using (
    status = 'pending'
    and expires_at > now()
    and (
      recipient_id = auth.uid()
      or (
        recipient_id is null
        and lower(recipient_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      )
    )
  );

drop policy if exists nanfu_transfers_insert_sender on public.nanfu_transfers;
create policy nanfu_transfers_insert_sender
  on public.nanfu_transfers for insert to authenticated
  with check (
    sender_id = auth.uid()
    and status = 'pending'
    and accepted_at is null
    and recipient_id is null
    and expires_at > now()
  );

-- Only the sender may update, and only to revoke. Everything else is pinned by
-- the guard trigger below so a sender cannot swap in another person's package.
drop policy if exists nanfu_transfers_update_sender on public.nanfu_transfers;
create policy nanfu_transfers_update_sender
  on public.nanfu_transfers for update to authenticated
  using (sender_id = auth.uid() and status = 'pending')
  with check (sender_id = auth.uid() and status in ('pending', 'revoked') and accepted_at is null);

drop policy if exists nanfu_transfers_delete_sender on public.nanfu_transfers;
create policy nanfu_transfers_delete_sender
  on public.nanfu_transfers for delete to authenticated
  using (sender_id = auth.uid());

create or replace function public.nanfu_transfers_guard()
returns trigger
language plpgsql
as $$
declare
  caller uuid := auth.uid();
begin
  -- Identity, addressee and package are immutable for everyone.
  if new.sender_id is distinct from old.sender_id
     or new.recipient_email is distinct from old.recipient_email
     or new.environment_id is distinct from old.environment_id
     or new.environment_name is distinct from old.environment_name
     or new.payload is distinct from old.payload
     or new.expires_at is distinct from old.expires_at
     or new.created_at is distinct from old.created_at
     or new.sender_email is distinct from old.sender_email then
    raise exception 'a transfer cannot change its sender, recipient, package or expiry'
      using errcode = '42501';
  end if;

  if old.status <> 'pending' then
    raise exception 'only a pending transfer can change' using errcode = 'P0001';
  end if;

  if new.status = 'revoked' then
    if caller is distinct from old.sender_id then
      raise exception 'only the sender can revoke a transfer' using errcode = '42501';
    end if;
    if new.accepted_at is not null or new.recipient_id is distinct from old.recipient_id then
      raise exception 'revoking a transfer changes nothing else' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.status = 'accepted' then
    if caller is null
       or not (
         old.recipient_id = caller
         or (old.recipient_id is null and lower(old.recipient_email) = lower(coalesce(auth.jwt() ->> 'email', '')))
       ) then
      raise exception 'this transfer is not addressed to you' using errcode = '42501';
    end if;
    if new.recipient_id is distinct from caller then
      raise exception 'a transfer can only be accepted by its recipient' using errcode = '42501';
    end if;
    if now() > old.expires_at then
      raise exception 'this transfer has expired' using errcode = 'P0001';
    end if;
    new.accepted_at := now();
    return new;
  end if;

  if new.accepted_at is not null or new.recipient_id is distinct from old.recipient_id then
    raise exception 'a pending transfer keeps its acceptance fields empty' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists nanfu_transfers_guard on public.nanfu_transfers;
create trigger nanfu_transfers_guard
  before update on public.nanfu_transfers
  for each row execute function public.nanfu_transfers_guard();

-- The recipient reads and accepts through this one function. It runs with the
-- definer's privileges so the recipient needs no UPDATE grant, while the guard
-- trigger still checks that the caller is the addressee.
create or replace function public.nanfu_accept_transfer(p_id uuid)
returns table (
  environment_id text,
  environment_name text,
  payload text,
  sender_email text,
  accepted_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller uuid := auth.uid();
  caller_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  row public.nanfu_transfers;
begin
  if caller is null then
    raise exception 'sign in before accepting a transfer' using errcode = '28000';
  end if;

  select t.* into row from public.nanfu_transfers t where t.id = p_id for update;
  if not found then
    raise exception 'transfer not found' using errcode = 'P0002';
  end if;
  if row.status <> 'pending' then
    raise exception 'this transfer is no longer pending' using errcode = 'P0001';
  end if;
  if row.expires_at <= now() then
    raise exception 'this transfer has expired' using errcode = 'P0001';
  end if;
  if not (row.recipient_id = caller or (row.recipient_id is null and lower(row.recipient_email) = caller_email)) then
    raise exception 'this transfer is not addressed to you' using errcode = '42501';
  end if;

  update public.nanfu_transfers
     set status = 'accepted', recipient_id = caller, accepted_at = now()
   where id = p_id;

  return query
    select row.environment_id, row.environment_name, row.payload, row.sender_email, row.accepted_at;
end;
$$;

revoke all on function public.nanfu_accept_transfer(uuid) from public;
revoke all on function public.nanfu_accept_transfer(uuid) from anon;
grant execute on function public.nanfu_accept_transfer(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Organizations: identity, role templates, groups, member grants
-- ---------------------------------------------------------------------------
-- Two separate concepts:
--   * identity (owner / admin / manager / member) decides SCOPE: whose windows
--     a person can see, and whose subtree a manager can administer;
--   * role template (nanfu_org_roles.permissions) decides ABILITY: which
--     operations are allowed. Identity is never hardcoded to a permission set,
--     so an organization can rename or re-scope its own roles.
--
-- Visibility of a window is: owner of the window OR owner/admin of the
-- organization OR manager of the owner's subtree OR member granted the window's
-- group. Everything else sees nothing.
--
-- One account belongs to at most one organization; the owner row is created
-- together with the organization and can never be removed.

create table if not exists public.nanfu_orgs (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default '' check (char_length(name) <= 120),
  -- Ceiling for the whole organization; 0 means no ceiling.
  plan_env_max integer not null default 0 check (plan_env_max >= 0),
  created_at timestamptz not null default now()
);

create unique index if not exists nanfu_orgs_owner_idx
  on public.nanfu_orgs (owner_user_id);

create table if not exists public.nanfu_org_roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.nanfu_orgs (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  -- Permission bits: env.create, env.delete, env.transfer, member.view,
  -- member.manage, member.quota, group.manage.
  permissions text[] not null default '{}',
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

create table if not exists public.nanfu_org_groups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.nanfu_orgs (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

create table if not exists public.nanfu_org_members (
  org_id uuid not null references public.nanfu_orgs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  email text not null default '' check (char_length(email) <= 320),
  identity text not null default 'member' check (identity in ('owner', 'admin', 'manager', 'member')),
  role_id uuid references public.nanfu_org_roles (id) on delete set null,
  -- Manager chain: a manager sees and administers its own subtree.
  manager_user_id uuid references auth.users (id) on delete set null,
  -- Windows this person may create; 0 means unlimited (owner).
  env_quota integer not null default 0 check (env_quota >= 0),
  status text not null default 'active' check (status in ('active', 'disabled')),
  -- locked   = cannot sign in or operate, data kept.
  -- disabled = unusable entirely, excluded from grants and quotas.
  locked boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id),
  unique (user_id)
);

create table if not exists public.nanfu_org_group_grants (
  group_id uuid not null references public.nanfu_org_groups (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  org_id uuid not null references public.nanfu_orgs (id) on delete cascade,
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index if not exists nanfu_org_grants_user_idx
  on public.nanfu_org_group_grants (org_id, user_id);

create table if not exists public.nanfu_org_invites (
  code text primary key,
  org_id uuid not null references public.nanfu_orgs (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  identity text not null default 'member' check (identity in ('admin', 'manager', 'member')),
  role_id uuid references public.nanfu_org_roles (id) on delete set null,
  env_quota integer not null default 0 check (env_quota >= 0),
  manager_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  redeemed_by uuid references auth.users (id) on delete set null,
  redeemed_at timestamptz,
  constraint nanfu_org_invites_expiry_after_creation check (expires_at > created_at),
  constraint nanfu_org_invites_redeemed_pair check ((redeemed_by is null) = (redeemed_at is null))
);

create index if not exists nanfu_org_invites_org_idx
  on public.nanfu_org_invites (org_id, created_at desc);

-- One row per ownership change: a pending hand-over, or the receipt of an
-- accepted / rejected / forced move. Forced moves (owner reclaim, member
-- removal, bulk "change employee") stay queryable here for the audit trail.
create table if not exists public.nanfu_env_transfers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.nanfu_orgs (id) on delete cascade,
  environment_id text not null check (char_length(environment_id) between 1 and 128),
  from_user_id uuid not null references auth.users (id) on delete cascade,
  to_user_id uuid not null references auth.users (id) on delete cascade,
  requested_by uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  forced boolean not null default false,
  note text not null default '' check (char_length(note) <= 500),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint nanfu_env_transfers_resolved_pair check ((status = 'pending') = (resolved_at is null)),
  constraint nanfu_env_transfers_distinct_people check (from_user_id <> to_user_id)
);

create index if not exists nanfu_env_transfers_org_idx
  on public.nanfu_env_transfers (org_id, created_at desc);
create index if not exists nanfu_env_transfers_mine_idx
  on public.nanfu_env_transfers (to_user_id, status);
create index if not exists nanfu_env_transfers_from_idx
  on public.nanfu_env_transfers (from_user_id, status);

alter table public.nanfu_orgs enable row level security;
alter table public.nanfu_org_roles enable row level security;
alter table public.nanfu_org_groups enable row level security;
alter table public.nanfu_org_members enable row level security;
alter table public.nanfu_org_group_grants enable row level security;
alter table public.nanfu_org_invites enable row level security;
alter table public.nanfu_env_transfers enable row level security;

revoke all on table public.nanfu_orgs from anon;
revoke all on table public.nanfu_org_roles from anon;
revoke all on table public.nanfu_org_groups from anon;
revoke all on table public.nanfu_org_members from anon;
revoke all on table public.nanfu_org_group_grants from anon;
revoke all on table public.nanfu_org_invites from anon;
revoke all on table public.nanfu_env_transfers from anon;

-- Every write goes through a SECURITY DEFINER function below; direct table
-- writes are not granted, so a member cannot smuggle in a role or a grant.
grant select on table public.nanfu_orgs to authenticated;
grant select on table public.nanfu_org_roles to authenticated;
grant select on table public.nanfu_org_groups to authenticated;
grant select on table public.nanfu_org_members to authenticated;
grant select on table public.nanfu_org_group_grants to authenticated;
grant select on table public.nanfu_org_invites to authenticated;
grant select on table public.nanfu_env_transfers to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Membership helpers (SECURITY DEFINER; they bypass RLS only to answer
--    membership questions, and only about the caller-supplied org)
-- ---------------------------------------------------------------------------

create or replace function public.nanfu_org_identity(p_org uuid, p_user uuid)
returns text
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select m.identity
    from public.nanfu_org_members m
   where m.org_id = p_org and m.user_id = p_user
   limit 1;
$$;

-- Active and not locked: the only state in which a member may see or do
-- anything organizational.
create or replace function public.nanfu_org_is_active(p_org uuid, p_user uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select coalesce((
    select m.status = 'active' and not m.locked
      from public.nanfu_org_members m
     where m.org_id = p_org and m.user_id = p_user
     limit 1
  ), false);
$$;

-- Everyone below `p_root` in the manager chain, plus `p_root`. `union`
-- (not `union all`) stops a malformed cycle from looping forever.
create or replace function public.nanfu_org_subtree(p_org uuid, p_root uuid)
returns table (user_id uuid)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  with recursive tree as (
    select m.user_id
      from public.nanfu_org_members m
     where m.org_id = p_org and m.user_id = p_root
    union
    select m.user_id
      from public.nanfu_org_members m
      join tree t on m.manager_user_id = t.user_id
     where m.org_id = p_org
  )
  select tree.user_id from tree;
$$;

create or replace function public.nanfu_org_can_admin(p_org uuid, p_user uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select coalesce((
    select m.status = 'active' and not m.locked and m.identity in ('owner', 'admin')
      from public.nanfu_org_members m
     where m.org_id = p_org and m.user_id = p_user
     limit 1
  ), false);
$$;

create or replace function public.nanfu_org_can_view_member(p_org uuid, p_caller uuid, p_target uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select case
    when p_caller is null then false
    when p_caller = p_target then true
    when public.nanfu_org_can_admin(p_org, p_caller) then true
    when public.nanfu_org_identity(p_org, p_caller) = 'manager'
         and public.nanfu_org_is_active(p_org, p_caller)
      then exists (select 1 from public.nanfu_org_subtree(p_org, p_caller) s where s.user_id = p_target)
    else false
  end;
$$;

-- The single visibility rule for a window. A locked/disabled member loses even
-- their own organizational rows: the data stays, the account cannot use it.
create or replace function public.nanfu_env_visible(
  p_owner uuid,
  p_org uuid,
  p_group uuid,
  p_caller uuid
)
returns boolean
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  me public.nanfu_org_members;
begin
  if p_caller is null then return false; end if;
  if p_org is null then return p_caller = p_owner; end if;
  select m.* into me from public.nanfu_org_members m
   where m.org_id = p_org and m.user_id = p_caller;
  if not found then return false; end if;
  if me.status <> 'active' or me.locked then return false; end if;
  if p_caller = p_owner then return true; end if;
  if me.identity in ('owner', 'admin') then return true; end if;
  if me.identity = 'manager' then
    return exists (select 1 from public.nanfu_org_subtree(p_org, p_caller) s where s.user_id = p_owner);
  end if;
  if p_group is null then return false; end if;
  return exists (
    select 1 from public.nanfu_org_group_grants g
     where g.group_id = p_group and g.user_id = p_caller and g.org_id = p_org
  );
end;
$$;

-- Who may rewrite a window: its owner (while active), or the org owner/admin.
create or replace function public.nanfu_env_writable(p_owner uuid, p_org uuid, p_caller uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select case
    when p_caller is null then false
    when p_org is null then p_caller = p_owner
    when p_caller = p_owner then public.nanfu_org_is_active(p_org, p_caller)
    else public.nanfu_org_can_admin(p_org, p_caller)
  end;
$$;

-- Raise 42501 unless the caller is an active member with the permission.
-- Owner/admin always pass; everyone else needs the bit on the assigned role.
create or replace function public.nanfu_org_require(p_perm text)
returns public.nanfu_org_members
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  me public.nanfu_org_members;
begin
  if auth.uid() is null then
    raise exception 'NANFU_FORBIDDEN: sign in first' using errcode = '28000';
  end if;
  select m.* into me from public.nanfu_org_members m where m.user_id = auth.uid();
  if not found then
    raise exception 'NANFU_FORBIDDEN: you do not belong to an organization' using errcode = '42501';
  end if;
  if me.status <> 'active' or me.locked then
    raise exception 'NANFU_MEMBER_INACTIVE: this account is locked or disabled' using errcode = '42501';
  end if;
  if me.identity in ('owner', 'admin') or p_perm is null then
    return me;
  end if;
  if me.role_id is null
     or not exists (
       select 1 from public.nanfu_org_roles r
        where r.id = me.role_id and p_perm = any (r.permissions)
     ) then
    raise exception 'NANFU_FORBIDDEN: missing permission %', p_perm using errcode = '42501';
  end if;
  return me;
end;
$$;

-- A manager may only touch its own subtree; members may not administer at all.
create or replace function public.nanfu_org_assert_target(p_me public.nanfu_org_members, p_target uuid)
returns void
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if p_me.identity in ('owner', 'admin') then return; end if;
  if p_me.identity = 'manager'
     and exists (select 1 from public.nanfu_org_subtree(p_me.org_id, p_me.user_id) s where s.user_id = p_target) then
    return;
  end if;
  raise exception 'NANFU_FORBIDDEN: this member is outside your scope' using errcode = '42501';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Environment ownership: org_id + group_id on every synced window
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'nanfu_environments' and column_name = 'user_id'
  ) and not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'nanfu_environments' and column_name = 'owner_user_id'
  ) then
    alter table public.nanfu_environments rename column user_id to owner_user_id;
  end if;
end;
$$;

alter table public.nanfu_environments add column if not exists org_id uuid references public.nanfu_orgs (id) on delete set null;
alter table public.nanfu_environments add column if not exists group_id uuid references public.nanfu_org_groups (id) on delete set null;

create index if not exists nanfu_environments_owner_idx
  on public.nanfu_environments (owner_user_id, updated_at desc);
create index if not exists nanfu_environments_org_idx
  on public.nanfu_environments (org_id, group_id, owner_user_id);

-- Not FORCE: the SECURITY DEFINER functions below must count rows across the
-- whole organization (quota, overview) and FORCE would subject them to RLS.
alter table public.nanfu_environments no force row level security;

drop policy if exists nanfu_environments_select_own on public.nanfu_environments;
drop policy if exists nanfu_environments_insert_own on public.nanfu_environments;
drop policy if exists nanfu_environments_update_own on public.nanfu_environments;
drop policy if exists nanfu_environments_delete_own on public.nanfu_environments;

drop policy if exists nanfu_environments_select_scope on public.nanfu_environments;
create policy nanfu_environments_select_scope
  on public.nanfu_environments for select to authenticated
  using (public.nanfu_env_visible(owner_user_id, org_id, group_id, auth.uid()));

drop policy if exists nanfu_environments_insert_scope on public.nanfu_environments;
create policy nanfu_environments_insert_scope
  on public.nanfu_environments for insert to authenticated
  with check (
    owner_user_id = auth.uid()
    and (org_id is null or public.nanfu_org_is_active(org_id, auth.uid()))
  );

-- A window is written by its owner; the organization owner/admin may also
-- repair it. A member granted a group can read it but not rewrite it.
drop policy if exists nanfu_environments_update_scope on public.nanfu_environments;
create policy nanfu_environments_update_scope
  on public.nanfu_environments for update to authenticated
  using (public.nanfu_env_writable(owner_user_id, org_id, auth.uid()))
  with check (public.nanfu_env_writable(owner_user_id, org_id, auth.uid()));

drop policy if exists nanfu_environments_delete_scope on public.nanfu_environments;
create policy nanfu_environments_delete_scope
  on public.nanfu_environments for delete to authenticated
  using (public.nanfu_env_writable(owner_user_id, org_id, auth.uid()));

-- ---------------------------------------------------------------------------
-- 6. Quotas: per-member env_quota and per-organization plan_env_max
-- ---------------------------------------------------------------------------
-- Existing windows above a lowered quota stay readable (and the UI flags them
-- red); only creating / receiving a new window is rejected, with a coded error
-- the client can show instead of silently failing.

create or replace function public.nanfu_org_check_quota(p_org uuid, p_owner uuid, p_add integer default 1)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me public.nanfu_org_members;
  cap integer;
  used integer;
  total integer;
begin
  select m.* into me from public.nanfu_org_members m
   where m.org_id = p_org and m.user_id = p_owner;
  if not found then
    raise exception 'NANFU_GROUP_INVALID: the window owner is not a member of this organization'
      using errcode = 'P0001';
  end if;
  if me.identity <> 'owner' and (me.status <> 'active' or me.locked) then
    raise exception 'NANFU_MEMBER_INACTIVE: this member cannot create or receive windows'
      using errcode = 'P0001';
  end if;
  select o.plan_env_max into cap from public.nanfu_orgs o where o.id = p_org;
  select count(*) into total
    from public.nanfu_environments e
   where e.org_id = p_org and not e.deleted;
  if cap > 0 and total + p_add > cap then
    raise exception 'NANFU_ORG_QUOTA: the organization may create % windows, % already used',
      cap, total using errcode = 'P0001';
  end if;
  if me.identity = 'owner' then
    return;
  end if;
  select count(*) into used
    from public.nanfu_environments e
   where e.org_id = p_org and e.owner_user_id = p_owner and not e.deleted;
  if me.env_quota > 0 and used + p_add > me.env_quota then
    raise exception 'NANFU_ENV_QUOTA: this member may create % windows, % already used',
      me.env_quota, used using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.nanfu_environments_quota()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.org_id is null then
    new.group_id := null;
    return new;
  end if;
  if new.group_id is not null and not exists (
    select 1 from public.nanfu_org_groups g where g.id = new.group_id and g.org_id = new.org_id
  ) then
    raise exception 'NANFU_GROUP_INVALID: the group does not belong to this organization'
      using errcode = 'P0001';
  end if;
  perform public.nanfu_org_check_quota(new.org_id, new.owner_user_id, 1);
  return new;
end;
$$;

drop trigger if exists nanfu_environments_quota on public.nanfu_environments;
create trigger nanfu_environments_quota
  before insert on public.nanfu_environments
  for each row execute function public.nanfu_environments_quota();

-- ---------------------------------------------------------------------------
-- 7. Organization policies
-- ---------------------------------------------------------------------------

drop policy if exists nanfu_orgs_select on public.nanfu_orgs;
create policy nanfu_orgs_select
  on public.nanfu_orgs for select to authenticated
  using (public.nanfu_org_identity(id, auth.uid()) is not null);

drop policy if exists nanfu_org_roles_select on public.nanfu_org_roles;
create policy nanfu_org_roles_select
  on public.nanfu_org_roles for select to authenticated
  using (public.nanfu_org_is_active(org_id, auth.uid()));

drop policy if exists nanfu_org_groups_select on public.nanfu_org_groups;
create policy nanfu_org_groups_select
  on public.nanfu_org_groups for select to authenticated
  using (public.nanfu_org_is_active(org_id, auth.uid()));

drop policy if exists nanfu_org_members_select on public.nanfu_org_members;
create policy nanfu_org_members_select
  on public.nanfu_org_members for select to authenticated
  using (public.nanfu_org_can_view_member(org_id, auth.uid(), user_id));

drop policy if exists nanfu_org_group_grants_select on public.nanfu_org_group_grants;
create policy nanfu_org_group_grants_select
  on public.nanfu_org_group_grants for select to authenticated
  using (public.nanfu_org_can_view_member(org_id, auth.uid(), user_id));

drop policy if exists nanfu_org_invites_select on public.nanfu_org_invites;
create policy nanfu_org_invites_select
  on public.nanfu_org_invites for select to authenticated
  using (created_by = auth.uid() or public.nanfu_org_can_admin(org_id, auth.uid()));

drop policy if exists nanfu_env_transfers_select on public.nanfu_env_transfers;
create policy nanfu_env_transfers_select
  on public.nanfu_env_transfers for select to authenticated
  using (
    from_user_id = auth.uid()
    or to_user_id = auth.uid()
    or requested_by = auth.uid()
    or public.nanfu_org_can_admin(org_id, auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 8. Organization RPCs
-- ---------------------------------------------------------------------------

create or replace function public.nanfu_org_create(p_name text default '')
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  oid uuid;
begin
  if me is null then
    raise exception 'NANFU_FORBIDDEN: sign in first' using errcode = '28000';
  end if;
  if exists (select 1 from public.nanfu_org_members m where m.user_id = me) then
    raise exception 'NANFU_FORBIDDEN: this account already belongs to an organization' using errcode = '42501';
  end if;
  insert into public.nanfu_orgs (owner_user_id, name)
  values (me, coalesce(p_name, ''))
  returning id into oid;
  insert into public.nanfu_org_members (org_id, user_id, email, identity, env_quota)
  values (oid, me, coalesce(auth.jwt() ->> 'email', ''), 'owner', 0);
  insert into public.nanfu_org_roles (org_id, name, permissions, is_system) values
    (oid, '管理员', array['env.create', 'env.delete', 'env.transfer', 'member.view', 'member.manage', 'member.quota', 'group.manage'], true),
    (oid, '经理', array['env.create', 'env.delete', 'env.transfer', 'member.view', 'member.quota'], true),
    (oid, '成员', array['env.create', 'env.delete', 'env.transfer'], true);
  insert into public.nanfu_org_groups (org_id, name) values (oid, '默认分组');
  return oid;
end;
$$;

create or replace function public.nanfu_org_me()
returns table (
  org_id uuid,
  email text,
  identity text,
  role_id uuid,
  role_name text,
  permissions text[],
  env_quota integer,
  used integer,
  status text,
  locked boolean
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  me public.nanfu_org_members;
begin
  if auth.uid() is null then return; end if;
  select m.* into me from public.nanfu_org_members m where m.user_id = auth.uid();
  if not found then return; end if;
  return query
    select me.org_id,
           me.email,
           me.identity,
           me.role_id,
           r.name,
           coalesce(r.permissions, '{}'::text[]),
           me.env_quota,
           (select count(*)::integer from public.nanfu_environments e
             where e.org_id = me.org_id and e.owner_user_id = me.user_id and not e.deleted),
           me.status,
           me.locked
      from (select 1) one
      left join public.nanfu_org_roles r on r.id = me.role_id;
end;
$$;

create or replace function public.nanfu_org_overview()
returns table (
  user_id uuid,
  email text,
  identity text,
  role_id uuid,
  role_name text,
  permissions text[],
  env_quota integer,
  used integer,
  status text,
  locked boolean,
  manager_user_id uuid
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  me public.nanfu_org_members;
begin
  me := public.nanfu_org_require(null);
  return query
    select m.user_id,
           m.email,
           m.identity,
           m.role_id,
           r.name,
           coalesce(r.permissions, '{}'::text[]),
           m.env_quota,
           (select count(*)::integer from public.nanfu_environments e
             where e.org_id = m.org_id and e.owner_user_id = m.user_id and not e.deleted),
           m.status,
           m.locked,
           m.manager_user_id
      from public.nanfu_org_members m
      left join public.nanfu_org_roles r on r.id = m.role_id
     where m.org_id = me.org_id
       and (
         me.identity in ('owner', 'admin')
         or m.user_id = me.user_id
         or (me.identity = 'manager'
             and exists (select 1 from public.nanfu_org_subtree(me.org_id, me.user_id) s where s.user_id = m.user_id))
       )
     order by m.identity, m.email;
end;
$$;

create or replace function public.nanfu_org_create_role(p_name text, p_permissions text[])
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me public.nanfu_org_members;
  rid uuid;
begin
  me := public.nanfu_org_require('member.manage');
  if p_name is null or char_length(trim(p_name)) = 0 then
    raise exception 'a role needs a name' using errcode = 'P0001';
  end if;
  insert into public.nanfu_org_roles (org_id, name, permissions, is_system)
  values (me.org_id, trim(p_name), coalesce(p_permissions, '{}'::text[]), false)
  returning id into rid;
  return rid;
end;
$$;

create or replace function public.nanfu_org_set_member(
  p_user uuid,
  p_identity text default null,
  p_role uuid default null,
  p_manager uuid default null,
  p_status text default null,
  p_locked boolean default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me public.nanfu_org_members;
  target public.nanfu_org_members;
begin
  me := public.nanfu_org_require('member.manage');
  select m.* into target from public.nanfu_org_members m
   where m.org_id = me.org_id and m.user_id = p_user;
  if not found then
    raise exception 'NANFU_FORBIDDEN: this account is not in your organization' using errcode = '42501';
  end if;
  if target.identity = 'owner'
     or p_user = (select o.owner_user_id from public.nanfu_orgs o where o.id = me.org_id) then
    raise exception 'the owner cannot be changed' using errcode = '42501';
  end if;
  perform public.nanfu_org_assert_target(me, p_user);
  if p_identity is not null then
    if p_identity not in ('admin', 'manager', 'member') then
      raise exception 'unknown identity %', p_identity using errcode = 'P0001';
    end if;
    if p_identity = 'admin' and me.identity <> 'owner' then
      raise exception 'NANFU_FORBIDDEN: only the owner can appoint an administrator' using errcode = '42501';
    end if;
  end if;
  if p_role is not null and not exists (
    select 1 from public.nanfu_org_roles r where r.id = p_role and r.org_id = me.org_id
  ) then
    raise exception 'NANFU_FORBIDDEN: the role belongs to another organization' using errcode = '42501';
  end if;
  if p_manager is not null then
    if p_manager = p_user then
      raise exception 'a member cannot manage themselves' using errcode = 'P0001';
    end if;
    if not exists (
      select 1 from public.nanfu_org_members m where m.org_id = me.org_id and m.user_id = p_manager
    ) then
      raise exception 'NANFU_FORBIDDEN: the manager is not in this organization' using errcode = '42501';
    end if;
  end if;
  if p_status is not null and p_status not in ('active', 'disabled') then
    raise exception 'unknown status %', p_status using errcode = 'P0001';
  end if;
  update public.nanfu_org_members m
     set identity = coalesce(p_identity, m.identity),
         role_id = coalesce(p_role, m.role_id),
         manager_user_id = coalesce(p_manager, m.manager_user_id),
         status = coalesce(p_status, m.status),
         locked = coalesce(p_locked, m.locked)
   where m.org_id = me.org_id and m.user_id = p_user;
end;
$$;

create or replace function public.nanfu_org_set_quota(p_user uuid, p_quota integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me public.nanfu_org_members;
  target public.nanfu_org_members;
begin
  me := public.nanfu_org_require('member.quota');
  if p_quota is null or p_quota < 0 then
    raise exception 'a quota cannot be negative' using errcode = 'P0001';
  end if;
  select m.* into target from public.nanfu_org_members m
   where m.org_id = me.org_id and m.user_id = p_user;
  if not found then
    raise exception 'NANFU_FORBIDDEN: this account is not in your organization' using errcode = '42501';
  end if;
  if target.identity = 'owner' then
    raise exception 'the owner quota is set by the plan' using errcode = '42501';
  end if;
  perform public.nanfu_org_assert_target(me, p_user);
  update public.nanfu_org_members m set env_quota = p_quota
   where m.org_id = me.org_id and m.user_id = p_user;
end;
$$;

create or replace function public.nanfu_org_create_group(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me public.nanfu_org_members;
  gid uuid;
begin
  me := public.nanfu_org_require('group.manage');
  if p_name is null or char_length(trim(p_name)) = 0 then
    raise exception 'a group needs a name' using errcode = 'P0001';
  end if;
  insert into public.nanfu_org_groups (org_id, name)
  values (me.org_id, trim(p_name))
  returning id into gid;
  return gid;
end;
$$;

create or replace function public.nanfu_org_grant_group(p_group uuid, p_user uuid, p_granted boolean default true)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me public.nanfu_org_members;
  target public.nanfu_org_members;
begin
  me := public.nanfu_org_require('group.manage');
  if not exists (select 1 from public.nanfu_org_groups g where g.id = p_group and g.org_id = me.org_id) then
    raise exception 'NANFU_GROUP_INVALID: the group is not in your organization' using errcode = '42501';
  end if;
  select m.* into target from public.nanfu_org_members m
   where m.org_id = me.org_id and m.user_id = p_user;
  if not found then
    raise exception 'NANFU_FORBIDDEN: this account is not in your organization' using errcode = '42501';
  end if;
  perform public.nanfu_org_assert_target(me, p_user);
  if coalesce(p_granted, true) then
    insert into public.nanfu_org_group_grants (group_id, user_id, org_id, granted_by)
    values (p_group, p_user, me.org_id, auth.uid())
    on conflict (group_id, user_id) do nothing;
  else
    delete from public.nanfu_org_group_grants g
     where g.group_id = p_group and g.user_id = p_user and g.org_id = me.org_id;
  end if;
end;
$$;

create or replace function public.nanfu_org_create_invite(
  p_identity text default 'member',
  p_role uuid default null,
  p_quota integer default 0,
  p_manager uuid default null,
  p_hours integer default 168
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me public.nanfu_org_members;
  code text;
begin
  me := public.nanfu_org_require('member.manage');
  if p_identity not in ('admin', 'manager', 'member') then
    raise exception 'unknown identity %', p_identity using errcode = 'P0001';
  end if;
  if p_identity = 'admin' and me.identity <> 'owner' then
    raise exception 'NANFU_FORBIDDEN: only the owner can invite an administrator' using errcode = '42501';
  end if;
  if p_role is not null and not exists (
    select 1 from public.nanfu_org_roles r where r.id = p_role and r.org_id = me.org_id
  ) then
    raise exception 'NANFU_FORBIDDEN: the role belongs to another organization' using errcode = '42501';
  end if;
  if p_manager is not null and not exists (
    select 1 from public.nanfu_org_members m where m.org_id = me.org_id and m.user_id = p_manager
  ) then
    raise exception 'NANFU_FORBIDDEN: the manager is not in this organization' using errcode = '42501';
  end if;
  if p_quota is null or p_quota < 0 then
    raise exception 'a quota cannot be negative' using errcode = 'P0001';
  end if;
  code := replace(gen_random_uuid()::text, '-', '');
  insert into public.nanfu_org_invites (code, org_id, created_by, identity, role_id, env_quota, manager_user_id, expires_at)
  values (
    code,
    me.org_id,
    auth.uid(),
    p_identity,
    p_role,
    p_quota,
    p_manager,
    now() + make_interval(hours => greatest(1, coalesce(p_hours, 168)))
  );
  return code;
end;
$$;

create or replace function public.nanfu_org_redeem_invite(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  invite public.nanfu_org_invites;
begin
  if me is null then
    raise exception 'NANFU_FORBIDDEN: sign in first' using errcode = '28000';
  end if;
  if exists (select 1 from public.nanfu_org_members m where m.user_id = me) then
    raise exception 'NANFU_FORBIDDEN: this account already belongs to an organization' using errcode = '42501';
  end if;
  select i.* into invite from public.nanfu_org_invites i where i.code = p_code for update;
  if not found then
    raise exception 'this invite does not exist' using errcode = 'P0002';
  end if;
  if invite.redeemed_by is not null then
    raise exception 'this invite has already been used' using errcode = 'P0001';
  end if;
  if invite.expires_at <= now() then
    raise exception 'this invite has expired' using errcode = 'P0001';
  end if;
  insert into public.nanfu_org_members (org_id, user_id, email, identity, role_id, manager_user_id, env_quota)
  values (
    invite.org_id,
    me,
    coalesce(auth.jwt() ->> 'email', ''),
    invite.identity,
    invite.role_id,
    invite.manager_user_id,
    invite.env_quota
  );
  update public.nanfu_org_invites i
     set redeemed_by = me, redeemed_at = now()
   where i.code = p_code;
  return invite.org_id;
end;
$$;

-- Removing a member: windows go back to the owner (default) and every move is
-- recorded; without reclaim they are detached from the organization so the
-- removed account keeps only what was already private.
create or replace function public.nanfu_org_remove_member(p_user uuid, p_reclaim boolean default true)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me public.nanfu_org_members;
  target public.nanfu_org_members;
  org_owner uuid;
  env_id text;
  moved integer := 0;
begin
  me := public.nanfu_org_require('member.manage');
  if p_user = auth.uid() then
    raise exception 'NANFU_FORBIDDEN: you cannot remove yourself' using errcode = '42501';
  end if;
  select m.* into target from public.nanfu_org_members m
   where m.org_id = me.org_id and m.user_id = p_user;
  if not found then
    raise exception 'NANFU_FORBIDDEN: this account is not in your organization' using errcode = '42501';
  end if;
  if target.identity = 'owner' then
    raise exception 'the owner cannot be removed' using errcode = '42501';
  end if;
  perform public.nanfu_org_assert_target(me, p_user);
  select o.owner_user_id into org_owner from public.nanfu_orgs o where o.id = me.org_id;

  if coalesce(p_reclaim, true) then
    for env_id in
      select e.environment_id from public.nanfu_environments e
       where e.org_id = me.org_id and e.owner_user_id = p_user and not e.deleted
       for update
    loop
      update public.nanfu_environments e
         set owner_user_id = org_owner
       where e.org_id = me.org_id and e.environment_id = env_id;
      insert into public.nanfu_env_transfers
        (org_id, environment_id, from_user_id, to_user_id, requested_by, status, forced, note, resolved_at)
      values
        (me.org_id, env_id, p_user, org_owner, auth.uid(), 'accepted', true, '成员被移除，窗口回收', now());
      moved := moved + 1;
    end loop;
  else
    update public.nanfu_environments e
       set org_id = null, group_id = null
     where e.org_id = me.org_id and e.owner_user_id = p_user;
  end if;

  delete from public.nanfu_org_group_grants g
   where g.org_id = me.org_id and g.user_id = p_user;
  delete from public.nanfu_org_members m
   where m.org_id = me.org_id and m.user_id = p_user;
  return moved;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Window transfers inside an organization
-- ---------------------------------------------------------------------------
-- Peer-to-peer (member to member) needs the recipient's confirmation.
-- Owner/admin moves are immediate and stay recorded with forced = true.

create or replace function public.nanfu_env_transfer_request(p_environment_id text, p_to uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me public.nanfu_org_members;
  env public.nanfu_environments;
  target public.nanfu_org_members;
  tid uuid;
begin
  me := public.nanfu_org_require('env.transfer');
  select e.* into env from public.nanfu_environments e
   where e.org_id = me.org_id and e.environment_id = p_environment_id and not e.deleted;
  if not found then
    raise exception 'NANFU_FORBIDDEN: this window is not visible in your organization' using errcode = '42501';
  end if;
  if env.owner_user_id <> auth.uid() then
    raise exception 'NANFU_FORBIDDEN: only the owner can offer this window' using errcode = '42501';
  end if;
  if p_to = auth.uid() then
    raise exception 'a window cannot be transferred to its owner' using errcode = 'P0001';
  end if;
  select m.* into target from public.nanfu_org_members m
   where m.org_id = me.org_id and m.user_id = p_to;
  if not found then
    raise exception 'NANFU_FORBIDDEN: the recipient is not in this organization' using errcode = '42501';
  end if;
  if target.status <> 'active' or target.locked then
    raise exception 'NANFU_MEMBER_INACTIVE: the recipient is locked or disabled' using errcode = 'P0001';
  end if;
  perform public.nanfu_org_check_quota(me.org_id, p_to, 1);
  insert into public.nanfu_env_transfers
    (org_id, environment_id, from_user_id, to_user_id, requested_by, status, note)
  values
    (me.org_id, p_environment_id, auth.uid(), p_to, auth.uid(), 'pending', '等待对方确认')
  returning id into tid;
  return tid;
end;
$$;

create or replace function public.nanfu_env_transfer_respond(p_id uuid, p_accept boolean)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me public.nanfu_org_members;
  row public.nanfu_env_transfers;
  env public.nanfu_environments;
begin
  me := public.nanfu_org_require(null);
  select t.* into row from public.nanfu_env_transfers t where t.id = p_id for update;
  if not found then
    raise exception 'transfer not found' using errcode = 'P0002';
  end if;
  if row.org_id <> me.org_id then
    raise exception 'NANFU_FORBIDDEN: this transfer belongs to another organization' using errcode = '42501';
  end if;
  if row.to_user_id <> auth.uid() then
    raise exception 'NANFU_FORBIDDEN: only the recipient can answer this transfer' using errcode = '42501';
  end if;
  if row.status <> 'pending' then
    raise exception 'this transfer is no longer pending' using errcode = 'P0001';
  end if;

  if not coalesce(p_accept, false) then
    update public.nanfu_env_transfers t
       set status = 'rejected', resolved_at = now()
     where t.id = p_id;
    return 'rejected';
  end if;

  select e.* into env from public.nanfu_environments e
   where e.org_id = row.org_id and e.environment_id = row.environment_id and not e.deleted
   for update;
  if not found then
    raise exception 'this window no longer exists' using errcode = 'P0002';
  end if;
  if env.owner_user_id <> row.from_user_id then
    raise exception 'this window no longer belongs to the sender' using errcode = 'P0001';
  end if;
  perform public.nanfu_org_check_quota(row.org_id, auth.uid(), 1);
  update public.nanfu_environments e
     set owner_user_id = auth.uid()
   where e.org_id = row.org_id and e.environment_id = row.environment_id;
  update public.nanfu_env_transfers t
     set status = 'accepted', resolved_at = now()
   where t.id = p_id;
  return 'accepted';
end;
$$;

-- Owner/admin: immediate move (reclaim to the owner, hand to a member, or bulk
-- "change employee"). Every row of the batch is recorded individually.
create or replace function public.nanfu_env_transfer_batch(p_environment_ids text[], p_to uuid, p_note text default '')
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me public.nanfu_org_members;
  target public.nanfu_org_members;
  env public.nanfu_environments;
  env_id text;
  moved integer := 0;
begin
  me := public.nanfu_org_require('env.transfer');
  if me.identity not in ('owner', 'admin') then
    raise exception 'NANFU_FORBIDDEN: only the owner or an administrator can force a transfer' using errcode = '42501';
  end if;
  select m.* into target from public.nanfu_org_members m
   where m.org_id = me.org_id and m.user_id = p_to;
  if not found then
    raise exception 'NANFU_FORBIDDEN: the recipient is not in this organization' using errcode = '42501';
  end if;
  if target.identity <> 'owner' and (target.status <> 'active' or target.locked) then
    raise exception 'NANFU_MEMBER_INACTIVE: the recipient is locked or disabled' using errcode = 'P0001';
  end if;
  foreach env_id in array coalesce(p_environment_ids, array[]::text[]) loop
    select e.* into env from public.nanfu_environments e
     where e.org_id = me.org_id and e.environment_id = env_id and not e.deleted
     for update;
    if not found then
      raise exception 'window % does not exist in your organization', env_id using errcode = 'P0002';
    end if;
    if env.owner_user_id = p_to then
      continue;
    end if;
    perform public.nanfu_org_check_quota(me.org_id, p_to, 1);
    update public.nanfu_environments e
       set owner_user_id = p_to
     where e.org_id = me.org_id and e.environment_id = env_id;
    insert into public.nanfu_env_transfers
      (org_id, environment_id, from_user_id, to_user_id, requested_by, status, forced, note, resolved_at)
    values
      (me.org_id, env_id, env.owner_user_id, p_to, auth.uid(), 'accepted', true,
       coalesce(nullif(trim(p_note), ''), '管理员变更归属'), now());
    moved := moved + 1;
  end loop;
  return moved;
end;
$$;

create or replace function public.nanfu_env_transfer_force(p_environment_id text, p_to uuid, p_note text default '')
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.nanfu_env_transfer_batch(array[p_environment_id], p_to, p_note);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Function grants
-- ---------------------------------------------------------------------------

revoke all on function public.nanfu_org_identity(uuid, uuid) from public;
revoke all on function public.nanfu_org_is_active(uuid, uuid) from public;
revoke all on function public.nanfu_org_subtree(uuid, uuid) from public;
revoke all on function public.nanfu_org_can_admin(uuid, uuid) from public;
revoke all on function public.nanfu_org_can_view_member(uuid, uuid, uuid) from public;
revoke all on function public.nanfu_env_visible(uuid, uuid, uuid, uuid) from public;
revoke all on function public.nanfu_env_writable(uuid, uuid, uuid) from public;
revoke all on function public.nanfu_org_require(text) from public;
revoke all on function public.nanfu_org_assert_target(public.nanfu_org_members, uuid) from public;
revoke all on function public.nanfu_org_check_quota(uuid, uuid, integer) from public;
revoke all on function public.nanfu_env_visible(uuid, uuid, uuid, uuid) from anon;
revoke all on function public.nanfu_org_check_quota(uuid, uuid, integer) from anon;

revoke all on function public.nanfu_org_create(text) from public, anon;
revoke all on function public.nanfu_org_me() from public, anon;
revoke all on function public.nanfu_org_overview() from public, anon;
revoke all on function public.nanfu_org_create_role(text, text[]) from public, anon;
revoke all on function public.nanfu_org_set_member(uuid, text, uuid, uuid, text, boolean) from public, anon;
revoke all on function public.nanfu_org_set_quota(uuid, integer) from public, anon;
revoke all on function public.nanfu_org_create_group(text) from public, anon;
revoke all on function public.nanfu_org_grant_group(uuid, uuid, boolean) from public, anon;
revoke all on function public.nanfu_org_create_invite(text, uuid, integer, uuid, integer) from public, anon;
revoke all on function public.nanfu_org_redeem_invite(text) from public, anon;
revoke all on function public.nanfu_org_remove_member(uuid, boolean) from public, anon;
revoke all on function public.nanfu_env_transfer_request(text, uuid) from public, anon;
revoke all on function public.nanfu_env_transfer_respond(uuid, boolean) from public, anon;
revoke all on function public.nanfu_env_transfer_batch(text[], uuid, text) from public, anon;
revoke all on function public.nanfu_env_transfer_force(text, uuid, text) from public, anon;

grant execute on function public.nanfu_org_identity(uuid, uuid) to authenticated;
grant execute on function public.nanfu_org_is_active(uuid, uuid) to authenticated;
grant execute on function public.nanfu_org_subtree(uuid, uuid) to authenticated;
grant execute on function public.nanfu_org_can_admin(uuid, uuid) to authenticated;
grant execute on function public.nanfu_org_can_view_member(uuid, uuid, uuid) to authenticated;
grant execute on function public.nanfu_env_visible(uuid, uuid, uuid, uuid) to authenticated;
grant execute on function public.nanfu_env_writable(uuid, uuid, uuid) to authenticated;
grant execute on function public.nanfu_org_require(text) to authenticated;
grant execute on function public.nanfu_org_assert_target(public.nanfu_org_members, uuid) to authenticated;
grant execute on function public.nanfu_org_check_quota(uuid, uuid, integer) to authenticated;

grant execute on function public.nanfu_org_create(text) to authenticated;
grant execute on function public.nanfu_org_me() to authenticated;
grant execute on function public.nanfu_org_overview() to authenticated;
grant execute on function public.nanfu_org_create_role(text, text[]) to authenticated;
grant execute on function public.nanfu_org_set_member(uuid, text, uuid, uuid, text, boolean) to authenticated;
grant execute on function public.nanfu_org_set_quota(uuid, integer) to authenticated;
grant execute on function public.nanfu_org_create_group(text) to authenticated;
grant execute on function public.nanfu_org_grant_group(uuid, uuid, boolean) to authenticated;
grant execute on function public.nanfu_org_create_invite(text, uuid, integer, uuid, integer) to authenticated;
grant execute on function public.nanfu_org_redeem_invite(text) to authenticated;
grant execute on function public.nanfu_org_remove_member(uuid, boolean) to authenticated;
grant execute on function public.nanfu_env_transfer_request(text, uuid) to authenticated;
grant execute on function public.nanfu_env_transfer_respond(uuid, boolean) to authenticated;
grant execute on function public.nanfu_env_transfer_batch(text[], uuid, text) to authenticated;
grant execute on function public.nanfu_env_transfer_force(text, uuid, text) to authenticated;
