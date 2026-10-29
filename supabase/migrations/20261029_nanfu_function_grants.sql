-- Reproducible function posture for the Nanfu organization schema.
--
-- Two things live here, both idempotent, so a fresh database ends up identical
-- to the one the operator adjusted by hand:
--   1. nanfu_org_check_quota's exempt path (owner, or any member who can
--      administer the organization, is never limited by env_quota; 0 means
--      unlimited for everyone else).
--   2. EXECUTE revoked from public/anon and granted only to authenticated for
--      every helper and RPC the client can reach.
-- Quota defaults and the self-service join live in
-- 20261029_nanfu_self_join.sql.

begin;

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
  -- Administrators work out of the organization ceiling only: their own
  -- env_quota stays untouched, because the people who hand out allowances must
  -- not be blocked by an allowance of their own. Members are capped, and a
  -- member allowance of 0 means unlimited.
  if me.identity = 'owner' or public.nanfu_org_can_admin(p_org, p_owner) then
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

revoke execute on function public.nanfu_org_subtree(uuid, uuid) from public, anon;
revoke execute on function public.nanfu_org_identity(uuid, uuid) from public, anon;
revoke execute on function public.nanfu_org_can_admin(uuid, uuid) from public, anon;
revoke execute on function public.nanfu_org_can_view_member(uuid, uuid, uuid) from public, anon;
revoke execute on function public.nanfu_org_require(text) from public, anon;
revoke execute on function public.nanfu_org_assert_target(public.nanfu_org_members, uuid) from public, anon;
revoke execute on function public.nanfu_env_visible(uuid, uuid, uuid, uuid) from public, anon;
revoke execute on function public.nanfu_env_writable(uuid, uuid, uuid) from public, anon;
revoke execute on function public.nanfu_org_check_quota(uuid, uuid, integer) from public, anon;
revoke execute on function public.nanfu_environments_touch() from public, anon;
revoke execute on function public.nanfu_transfers_guard() from public, anon;
revoke execute on function public.nanfu_environments_quota() from public, anon;

grant execute on function public.nanfu_org_subtree(uuid, uuid) to authenticated;
grant execute on function public.nanfu_org_identity(uuid, uuid) to authenticated;
grant execute on function public.nanfu_org_can_admin(uuid, uuid) to authenticated;
grant execute on function public.nanfu_org_can_view_member(uuid, uuid, uuid) to authenticated;
grant execute on function public.nanfu_org_require(text) to authenticated;
grant execute on function public.nanfu_org_assert_target(public.nanfu_org_members, uuid) to authenticated;
grant execute on function public.nanfu_env_visible(uuid, uuid, uuid, uuid) to authenticated;
grant execute on function public.nanfu_env_writable(uuid, uuid, uuid) to authenticated;
grant execute on function public.nanfu_org_check_quota(uuid, uuid, integer) to authenticated;
grant execute on function public.nanfu_environments_touch() to authenticated;
grant execute on function public.nanfu_transfers_guard() to authenticated;
grant execute on function public.nanfu_environments_quota() to authenticated;

commit;
