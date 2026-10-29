-- Free-tier quota defaults and the self-service join of the default workspace.
--
-- Quota semantics (agreed):
--   * nanfu_orgs.plan_env_max  : ceiling for the whole organization, 0 = no ceiling.
--     A self-created organization now starts at 20 windows.
--   * nanfu_org_members.env_quota : windows one member may create, 0 = unlimited.
--     Only members who cannot administer the organization are bounded by it;
--     the owner and any admin identity are exempt (see nanfu_org_check_quota in
--     20261029_nanfu_function_grants.sql). No billing, plan or price concept
--     exists anywhere in this schema, and the UI must not introduce one: the
--     only quota path is an administrator assigning a member allowance.
--
-- Re-runnable: everything below is an idempotent ALTER / CREATE OR REPLACE.

begin;

alter table public.nanfu_orgs
  alter column plan_env_max set default 20;

alter table public.nanfu_org_members
  alter column env_quota set default 0;

-- ---------------------------------------------------------------------------
-- public.nanfu_org_self_join()
--
-- A signed-in account that belongs to no organization yet is attached to the
-- default workspace as an ordinary member: identity 'member', the organization's
-- built-in '成员' role when it exists, manager = the organization owner and a
-- 20-window allowance. An account that already has an organization just gets its
-- own id back, so the client can call this on every sign-in and restart.
-- Ordering matters: a seat taken here closes the door on nanfu_org_redeem_invite
-- (it raises 'this account already belongs to an organization'), so sign-in
-- redeems an optional invite code before falling back to this function.
--
-- The default organization id is a constant inside the body rather than a
-- function parameter: PostgREST resolves /rpc/nanfu_org_self_join by signature,
-- and adding a defaulted parameter would register a second overload the client
-- would then have to disambiguate. Rebuild a workspace with a different default
-- organization by editing this one literal and re-running the file.
create or replace function public.nanfu_org_self_join()
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_default_org constant uuid := 'a21d2387-127a-4116-aedd-c16164ef1e58';
  c_default_quota constant integer := 20;
  me uuid := auth.uid();
  joined uuid;
  member_role uuid;
  org_owner uuid;
begin
  if me is null then
    raise exception 'NANFU_FORBIDDEN: sign in first' using errcode = '28000';
  end if;

  select m.org_id into joined from public.nanfu_org_members m where m.user_id = me;
  if found then
    return joined;
  end if;

  select o.owner_user_id into org_owner from public.nanfu_orgs o where o.id = c_default_org;
  if not found then
    raise exception 'NANFU_GROUP_INVALID: the default organization is not provisioned'
      using errcode = 'P0001';
  end if;

  select r.id into member_role from public.nanfu_org_roles r
   where r.org_id = c_default_org and r.name = '成员'
   limit 1;

  insert into public.nanfu_org_members
    (org_id, user_id, email, identity, role_id, manager_user_id, env_quota, status, locked)
  values
    (c_default_org, me, coalesce(auth.jwt() ->> 'email', ''), 'member',
     member_role, org_owner, c_default_quota, 'active', false)
  on conflict (user_id) do nothing
  returning org_id into joined;

  if joined is null then
    select m.org_id into joined from public.nanfu_org_members m where m.user_id = me;
  end if;

  return joined;
end;
$$;

-- The default workspace itself stays uncapped (plan_env_max = 0); its members
-- are limited individually. No-op when the row does not exist yet, which is the
-- case in a freshly built test database.
update public.nanfu_orgs set plan_env_max = 0 where id = 'a21d2387-127a-4116-aedd-c16164ef1e58';

comment on function public.nanfu_org_self_join() is
  'Attach the calling account to the default organization, or return the organization it already belongs to.';

-- Same posture as the other organization RPCs: anonymous gets nothing, and the
-- grant is never widened to public.
revoke execute on function public.nanfu_org_self_join() from public, anon;
grant execute on function public.nanfu_org_self_join() to authenticated;

commit;
