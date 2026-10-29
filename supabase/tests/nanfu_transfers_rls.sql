-- Row-level-security proof for the Nanfu transfer table.
--
-- Runs on a plain Postgres 16 in CI: this file recreates the small parts of
-- Supabase that the schema depends on (auth.users, auth.uid(), auth.jwt()) and
-- then exercises the policies as two real database roles. No network, no real
-- project, no test rows in the production database.
--
-- Run: psql -v ON_ERROR_STOP=1 -f supabase/tests/nanfu_transfers_rls.sql

\set ON_ERROR_STOP on
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text
);

-- Same shape as Supabase's helpers: they read the JWT claims PostgREST sets.
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
grant execute on function auth.jwt() to authenticated;

-- Minimal stand-in for the Supabase storage schema: the release migration only
-- needs storage.buckets to exist.
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false
);

-- Applied twice on purpose: the operator pastes this file after every update.
\i supabase/migrations/20261029_nanfu_environments.sql
\i supabase/migrations/20261029_nanfu_environments.sql
\i supabase/migrations/20261029_nanfu_function_grants.sql
\i supabase/migrations/20261029_nanfu_function_grants.sql
\i supabase/migrations/20261029_nanfu_self_join.sql
\i supabase/migrations/20261029_nanfu_self_join.sql
\i supabase/migrations/20261029_nanfu_releases.sql
\i supabase/migrations/20261029_nanfu_releases.sql
\i supabase/migrations/20261029_nanfu_signup_attempts.sql
\i supabase/migrations/20261029_nanfu_signup_attempts.sql

do $$
declare signature text; target regprocedure;
begin
  foreach signature in array array[
    'public.nanfu_org_subtree(uuid,uuid)', 'public.nanfu_org_identity(uuid,uuid)',
    'public.nanfu_org_can_admin(uuid,uuid)', 'public.nanfu_org_can_view_member(uuid,uuid,uuid)',
    'public.nanfu_org_require(text)', 'public.nanfu_org_assert_target(public.nanfu_org_members,uuid)',
    'public.nanfu_env_visible(uuid,uuid,uuid,uuid)', 'public.nanfu_env_writable(uuid,uuid,uuid)',
    'public.nanfu_org_check_quota(uuid,uuid,integer)', 'public.nanfu_environments_touch()',
    'public.nanfu_transfers_guard()', 'public.nanfu_environments_quota()',
    'public.nanfu_org_self_join()'
  ] loop
    target := to_regprocedure(signature);
    if target is null or has_function_privilege('anon', target, 'EXECUTE')
       or not has_function_privilege('authenticated', target, 'EXECUTE')
       or exists (select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  where p.oid = target and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      raise exception 'unexpected function grants for %', signature;
    end if;
  end loop;
end $$;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'sender@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'recipient@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'stranger@example.com')
on conflict (id) do nothing;

-- Seeded as the database owner, which bypasses RLS on purpose so the fixtures
-- exist regardless of what the policies allow the app to do.
delete from public.nanfu_transfers where sender_id = '11111111-1111-1111-1111-111111111111';
insert into public.nanfu_transfers
  (id, sender_id, sender_email, recipient_email, environment_id, environment_name, payload, status, created_at, expires_at)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'sender@example.com', 'recipient@example.com',
   'env-1', 'Mail box', '{"v":1,"ct":"Y2lwaGVy"}', 'pending', now() - interval '1 hour', now() + interval '6 days'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'sender@example.com', 'recipient@example.com',
   'env-expired', 'Old box', '{"v":1,"ct":"b2xk"}', 'pending', now() - interval '10 days', now() - interval '3 days');

-- ---------------------------------------------------------------------------
-- 1. Visibility: sender sees own rows, recipient only the live addressed one,
--    a stranger sees nothing. This is the anti-exfiltration proof.
-- ---------------------------------------------------------------------------
begin;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"sender@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n bigint;
begin
  select count(*) into n from public.nanfu_transfers;
  if n <> 2 then raise exception 'sender should see 2 own transfers, saw %', n; end if;
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","email":"recipient@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n bigint;
begin
  select count(*) into n from public.nanfu_transfers;
  if n <> 1 then raise exception 'recipient should see only the live transfer, saw %', n; end if;
  select count(*) into n from public.nanfu_transfers where environment_id = 'env-expired';
  if n <> 0 then raise exception 'recipient must not see an expired transfer'; end if;
  select count(*) into n from public.nanfu_transfers where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if n <> 1 then raise exception 'recipient must see the addressed transfer'; end if;
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"stranger@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n bigint;
begin
  select count(*) into n from public.nanfu_transfers;
  if n <> 0 then raise exception 'stranger read % foreign transfers', n; end if;
  select count(*) into n from public.nanfu_transfers where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if n <> 0 then raise exception 'stranger read a transfer by id'; end if;
end $$;
commit;

-- ---------------------------------------------------------------------------
-- 2. A recipient cannot rewrite a transfer: no update policy applies.
-- ---------------------------------------------------------------------------
begin;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","email":"recipient@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare changed bigint;
begin
  update public.nanfu_transfers set status = 'accepted'
   where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  get diagnostics changed = row_count;
  if changed <> 0 then raise exception 'recipient updated a row directly'; end if;
end $$;
commit;

-- ---------------------------------------------------------------------------
-- 3. A stranger cannot accept, and a recipient can only accept once.
-- ---------------------------------------------------------------------------
begin;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"stranger@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare blocked boolean := false;
begin
  begin
    perform public.nanfu_accept_transfer('aaaaaaaa-0000-0000-0000-000000000001');
  exception when insufficient_privilege then
    blocked := true;
  end;
  if not blocked then raise exception 'stranger accepted a transfer'; end if;
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","email":"recipient@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare accepted record; blocked boolean := false;
begin
  select * into accepted from public.nanfu_accept_transfer('aaaaaaaa-0000-0000-0000-000000000001');
  if accepted.payload <> '{"v":1,"ct":"Y2lwaGVy"}' then raise exception 'accept returned the wrong payload'; end if;
  if accepted.environment_id <> 'env-1' then raise exception 'accept returned the wrong environment'; end if;
  begin
    perform public.nanfu_accept_transfer('aaaaaaaa-0000-0000-0000-000000000001');
  exception when raise_exception then
    blocked := true;
  end;
  if not blocked then raise exception 'a transfer was accepted twice'; end if;
  if exists (select 1 from public.nanfu_transfers) then raise exception 'accepted transfer still visible to recipient'; end if;
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"sender@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare accepted boolean;
begin
  select (status = 'accepted' and accepted_at is not null) into accepted
    from public.nanfu_transfers where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if accepted is not true then raise exception 'sender cannot see the accepted receipt'; end if;
end $$;
commit;

-- ---------------------------------------------------------------------------
-- 4. The sender may revoke, but may never swap the package or addressee.
-- ---------------------------------------------------------------------------
begin;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"sender@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare blocked boolean := false; changed bigint;
begin
  begin
    update public.nanfu_transfers
       set payload = '{"v":1,"ct":"dGFtcGVyZWQ"}'
     where id = 'aaaaaaaa-0000-0000-0000-000000000002';
  exception when insufficient_privilege then
    blocked := true;
  end;
  if not blocked then raise exception 'sender rewrote the payload'; end if;

  update public.nanfu_transfers set status = 'revoked'
   where id = 'aaaaaaaa-0000-0000-0000-000000000002';
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception 'sender could not revoke'; end if;
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","email":"recipient@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare blocked boolean := false;
begin
  if exists (select 1 from public.nanfu_transfers where environment_id = 'env-expired') then
    raise exception 'recipient sees a revoked transfer';
  end if;
  begin
    perform public.nanfu_accept_transfer('aaaaaaaa-0000-0000-0000-000000000002');
  exception when raise_exception then
    blocked := true;
  end;
  if not blocked then raise exception 'revoked transfer was accepted'; end if;
end $$;
commit;

-- ---------------------------------------------------------------------------
-- 5. A user cannot send on behalf of someone else.
-- ---------------------------------------------------------------------------
begin;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"stranger@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare blocked boolean := false;
begin
  begin
    insert into public.nanfu_transfers
      (sender_id, sender_email, recipient_email, environment_id, payload)
    values
      ('22222222-2222-2222-2222-222222222222', 'recipient@example.com', 'stranger@example.com', 'forged', '{"v":1,"ct":"eA"}');
  exception when insufficient_privilege then
    blocked := true;
  end;
  if not blocked then raise exception 'stranger forged a sender identity'; end if;
end $$;
commit;

-- ---------------------------------------------------------------------------
-- 6. Environment rows keep the original tenant isolation.
-- ---------------------------------------------------------------------------
begin;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"sender@example.com","role":"authenticated"}', true);
set local role authenticated;
insert into public.nanfu_environments (owner_user_id, environment_id, payload)
values ('11111111-1111-1111-1111-111111111111', 'env-1', '{"v":1,"ct":"b3du"}');
commit;

begin;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","email":"recipient@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n bigint;
begin
  select count(*) into n from public.nanfu_environments;
  if n <> 0 then raise exception 'recipient read % foreign environments', n; end if;
end $$;
commit;

-- ---------------------------------------------------------------------------
-- 7. Organization fixtures: one owner, one admin, one manager, two members.
--    Everything below runs as `authenticated` with JWT claims, exactly like
--    PostgREST, so the RPCs and policies are exercised, not bypassed.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('44444444-4444-4444-4444-444444444444', 'owner@example.com'),
  ('55555555-5555-5555-5555-555555555555', 'admin@example.com'),
  ('66666666-6666-6666-6666-666666666666', 'manager@example.com'),
  ('77777777-7777-7777-7777-777777777777', 'member@example.com'),
  ('88888888-8888-8888-8888-888888888888', 'member2@example.com')
on conflict (id) do nothing;

-- Harness-only scratch table so one scenario can hand a code/id to the next.
create table if not exists public.nanfu_test_codes (label text primary key, code text not null);
grant select, insert, update, delete on public.nanfu_test_codes to authenticated;

begin;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","email":"owner@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare blocked boolean := false;
begin
  perform public.nanfu_org_create('测试团队');
  if (select count(*) from public.nanfu_orgs) <> 1 then raise exception 'org was not created'; end if;
  if (select identity from public.nanfu_org_members where user_id = auth.uid()) <> 'owner' then
    raise exception 'creator is not the owner';
  end if;
  begin
    perform public.nanfu_org_create('second');
  exception when insufficient_privilege then
    blocked := true;
  end;
  if not blocked then raise exception 'one account created two organizations'; end if;
  insert into public.nanfu_test_codes (label, code)
  select 'invite-admin', public.nanfu_org_create_invite('admin')::text;
  insert into public.nanfu_test_codes (label, code)
  select 'invite-manager', public.nanfu_org_create_invite('manager', r.id)
    from public.nanfu_org_roles r where r.name = '经理';
  insert into public.nanfu_test_codes (label, code)
  select 'group-support', public.nanfu_org_create_group('客服组')::text;
  insert into public.nanfu_test_codes (label, code)
  select 'group-private', public.nanfu_org_create_group('私密组')::text;
end $$;
commit;

-- Each invited account redeems its own code. A member already in the org
-- cannot redeem a second one.
begin;
select set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","email":"admin@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare blocked boolean := false;
begin
  perform public.nanfu_org_redeem_invite((select code from public.nanfu_test_codes where label = 'invite-admin'));
  if (select identity from public.nanfu_org_members where user_id = auth.uid()) <> 'admin' then
    raise exception 'admin invite produced the wrong identity';
  end if;
  begin
    perform public.nanfu_org_redeem_invite((select code from public.nanfu_test_codes where label = 'invite-manager'));
  exception when insufficient_privilege then
    blocked := true;
  end;
  if not blocked then raise exception 'an existing member joined twice'; end if;
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '66666666-6666-6666-6666-666666666666', true);
select set_config('request.jwt.claims', '{"sub":"66666666-6666-6666-6666-666666666666","email":"manager@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  perform public.nanfu_org_redeem_invite((select code from public.nanfu_test_codes where label = 'invite-manager'));
  if (select identity from public.nanfu_org_members where user_id = auth.uid()) <> 'manager' then
    raise exception 'manager invite produced the wrong identity';
  end if;
end $$;
commit;

-- The subordinate invites are issued after the manager has joined, because the
-- invite pins an existing manager.
begin;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","email":"owner@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  insert into public.nanfu_test_codes (label, code)
  select 'invite-member', public.nanfu_org_create_invite('member', r.id, 2, '66666666-6666-6666-6666-666666666666')
    from public.nanfu_org_roles r where r.name = '成员';
  insert into public.nanfu_test_codes (label, code)
  select 'invite-member2', public.nanfu_org_create_invite('member', r.id, 2, '66666666-6666-6666-6666-666666666666')
    from public.nanfu_org_roles r where r.name = '成员';
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', true);
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","email":"member@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  perform public.nanfu_org_redeem_invite((select code from public.nanfu_test_codes where label = 'invite-member'));
  if (select env_quota from public.nanfu_org_members where user_id = auth.uid()) <> 2 then
    raise exception 'member invite did not carry the quota';
  end if;
  if (select manager_user_id from public.nanfu_org_members where user_id = auth.uid())
     <> '66666666-6666-6666-6666-666666666666' then
    raise exception 'member invite did not carry the manager';
  end if;
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '88888888-8888-8888-8888-888888888888', true);
select set_config('request.jwt.claims', '{"sub":"88888888-8888-8888-8888-888888888888","email":"member2@example.com","role":"authenticated"}', true);
set local role authenticated;
select public.nanfu_org_redeem_invite((select code from public.nanfu_test_codes where label = 'invite-member2'));
commit;

-- The 客服组 grant is created once the member exists.
begin;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","email":"owner@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  perform public.nanfu_org_grant_group(
    (select code::uuid from public.nanfu_test_codes where label = 'group-support'),
    '77777777-7777-7777-7777-777777777777',
    true
  );
end $$;
commit;

-- ---------------------------------------------------------------------------
-- 8. Windows: owner, admin, manager and members each create one; the member
--    quota rejects the third window with a coded error.
-- ---------------------------------------------------------------------------

begin;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","email":"owner@example.com","role":"authenticated"}', true);
set local role authenticated;
insert into public.nanfu_environments (owner_user_id, org_id, environment_id, payload)
values ('44444444-4444-4444-4444-444444444444',
        (select id from public.nanfu_orgs), 'env-o', '{"v":1,"ct":"b3duZXI="}');
commit;

begin;
select set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","email":"admin@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare gid uuid;
begin
  select code::uuid into gid from public.nanfu_test_codes where label = 'group-support';
  insert into public.nanfu_environments (owner_user_id, org_id, group_id, environment_id, payload)
  values (auth.uid(), (select id from public.nanfu_orgs), gid, 'env-g', '{"v":1,"ct":"Z3JvdXA="}');
  select code::uuid into gid from public.nanfu_test_codes where label = 'group-private';
  insert into public.nanfu_environments (owner_user_id, org_id, group_id, environment_id, payload)
  values (auth.uid(), (select id from public.nanfu_orgs), gid, 'env-x', '{"v":1,"ct":"cHJpdmF0ZQ=="}');
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', true);
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","email":"member@example.com","role":"authenticated"}', true);
set local role authenticated;
insert into public.nanfu_environments (owner_user_id, org_id, environment_id, payload)
values (auth.uid(), (select id from public.nanfu_orgs), 'env-b', '{"v":1,"ct":"bWVtYmVy"}');
insert into public.nanfu_environments (owner_user_id, org_id, environment_id, payload)
values (auth.uid(), (select id from public.nanfu_orgs), 'env-b2', '{"v":1,"ct":"bWVtYmVyMg=="}');
do $$
declare blocked boolean := false;
begin
  begin
    insert into public.nanfu_environments (owner_user_id, org_id, environment_id, payload)
    values (auth.uid(), (select id from public.nanfu_orgs), 'env-b3', '{"v":1,"ct":"b3Zlcg=="}');
  exception when raise_exception then
    if sqlerrm not like 'NANFU_ENV_QUOTA:%' then raise; end if;
    blocked := true;
  end;
  if not blocked then raise exception 'a third window was created over a quota of 2'; end if;
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '88888888-8888-8888-8888-888888888888', true);
select set_config('request.jwt.claims', '{"sub":"88888888-8888-8888-8888-888888888888","email":"member2@example.com","role":"authenticated"}', true);
set local role authenticated;
insert into public.nanfu_environments (owner_user_id, org_id, environment_id, payload)
values (auth.uid(), (select id from public.nanfu_orgs), 'env-c', '{"v":1,"ct":"bWVtYmVyMg=="}');
commit;

begin;
select set_config('request.jwt.claim.sub', '66666666-6666-6666-6666-666666666666', true);
select set_config('request.jwt.claims', '{"sub":"66666666-6666-6666-6666-666666666666","email":"manager@example.com","role":"authenticated"}', true);
set local role authenticated;
insert into public.nanfu_environments (owner_user_id, org_id, environment_id, payload)
values (auth.uid(), (select id from public.nanfu_orgs), 'env-m', '{"v":1,"ct":"bWFuYWdlcg=="}');
commit;

-- ---------------------------------------------------------------------------
-- 9. Visibility: ungranted groups are invisible; managers see only their
--    subtree; owner/admin see the whole organization.
-- ---------------------------------------------------------------------------

begin;
select set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', true);
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","email":"member@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n bigint;
begin
  select count(*) into n from public.nanfu_environments;
  if n <> 3 then raise exception 'member should see own 2 + granted group 1, saw %', n; end if;
  if exists (select 1 from public.nanfu_environments where environment_id = 'env-x') then
    raise exception 'member saw a window in an ungranted group';
  end if;
  if exists (select 1 from public.nanfu_environments where environment_id = 'env-o') then
    raise exception 'member saw the owner window';
  end if;
  if exists (select 1 from public.nanfu_environments where environment_id = 'env-m') then
    raise exception 'member saw an unrelated manager window';
  end if;
  select count(*) into n from public.nanfu_org_members;
  if n <> 1 then raise exception 'member should only see their own member row, saw %', n; end if;
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '66666666-6666-6666-6666-666666666666', true);
select set_config('request.jwt.claims', '{"sub":"66666666-6666-6666-6666-666666666666","email":"manager@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n bigint;
begin
  select count(*) into n from public.nanfu_environments;
  if n <> 4 then raise exception 'manager should see self + two subordinates (4 windows), saw %', n; end if;
  if exists (select 1 from public.nanfu_environments where environment_id = 'env-g') then
    raise exception 'manager saw an admin window outside the subtree';
  end if;
  if exists (select 1 from public.nanfu_environments where environment_id = 'env-x') then
    raise exception 'manager saw a window in an ungranted group';
  end if;
  select count(*) into n from public.nanfu_org_members;
  if n <> 3 then raise exception 'manager should see self + two subordinates, saw %', n; end if;
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","email":"admin@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n bigint;
begin
  select count(*) into n from public.nanfu_environments;
  if n <> 7 then raise exception 'admin should see all 7 org windows, saw %', n; end if;
  select count(*) into n from public.nanfu_org_members;
  if n <> 5 then raise exception 'admin should see all 5 members, saw %', n; end if;
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"stranger@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n bigint; blocked boolean := false;
begin
  select count(*) into n from public.nanfu_environments;
  if n <> 0 then raise exception 'stranger read % org windows', n; end if;
  select count(*) into n from public.nanfu_org_members;
  if n <> 0 then raise exception 'stranger read % member rows', n; end if;
  begin
    perform * from public.nanfu_org_overview();
  exception when insufficient_privilege then
    blocked := true;
  end;
  if not blocked then raise exception 'stranger called the organization overview'; end if;
end $$;
commit;

-- ---------------------------------------------------------------------------
-- 10. Organization plan ceiling: a new window is rejected, existing ones stay.
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '', true);
update public.nanfu_orgs set plan_env_max = (select count(*) from public.nanfu_environments where org_id = public.nanfu_orgs.id);

begin;
select set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', true);
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","email":"member@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare blocked boolean := false; changed bigint;
begin
  begin
    insert into public.nanfu_environments (owner_user_id, org_id, environment_id, payload)
    values (auth.uid(), (select id from public.nanfu_orgs), 'env-over', '{"v":1,"ct":"eA=="}');
  exception when raise_exception then
    if sqlerrm not like 'NANFU_ORG_QUOTA:%' then raise; end if;
    blocked := true;
  end;
  if not blocked then raise exception 'organization ceiling did not reject the window'; end if;
  update public.nanfu_environments set payload = '{"v":1,"ct":"dXBkYXRlZA=="}' where environment_id = 'env-b';
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception 'an over-limit member could not edit an existing window'; end if;
end $$;
commit;

update public.nanfu_orgs set plan_env_max = 0;

-- ---------------------------------------------------------------------------
-- 11. Lock is not disable: a locked member loses reads and writes, data stays.
-- ---------------------------------------------------------------------------

begin;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","email":"owner@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  perform public.nanfu_org_set_member('77777777-7777-7777-7777-777777777777', null, null, null, null, true);
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', true);
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","email":"member@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n bigint; changed bigint; blocked boolean := false;
begin
  select count(*) into n from public.nanfu_environments;
  if n <> 0 then raise exception 'locked member still read % windows', n; end if;
  update public.nanfu_environments set payload = '{"v":1,"ct":"eA=="}' where environment_id = 'env-b';
  get diagnostics changed = row_count;
  if changed <> 0 then raise exception 'locked member updated a window'; end if;
  begin
    insert into public.nanfu_environments (owner_user_id, org_id, environment_id, payload)
    values (auth.uid(), (select id from public.nanfu_orgs), 'env-locked', '{"v":1,"ct":"eA=="}');
  exception
    when insufficient_privilege then
      blocked := true;
    when raise_exception then
      -- The quota trigger fires before the policy check; either refusal counts.
      if sqlerrm not like 'NANFU_MEMBER_INACTIVE:%' then raise; end if;
      blocked := true;
  end;
  if not blocked then raise exception 'locked member created a window'; end if;
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","email":"owner@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  perform public.nanfu_org_set_member('77777777-7777-7777-7777-777777777777', null, null, null, null, false);
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', true);
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","email":"member@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n bigint;
begin
  select count(*) into n from public.nanfu_environments;
  if n <> 3 then raise exception 'unlocked member still cannot read the 3 windows, saw %', n; end if;
end $$;
commit;

-- ---------------------------------------------------------------------------
-- 12. Peer transfer: request, recipient accepts, both lists change.
-- ---------------------------------------------------------------------------

begin;
select set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', true);
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","email":"member@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare tid uuid;
begin
  tid := public.nanfu_env_transfer_request('env-b', '88888888-8888-8888-8888-888888888888');
  insert into public.nanfu_test_codes (label, code) values ('transfer', tid::text)
  on conflict (label) do update set code = excluded.code;
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '88888888-8888-8888-8888-888888888888', true);
select set_config('request.jwt.claims', '{"sub":"88888888-8888-8888-8888-888888888888","email":"member2@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare tid uuid; outcome text; n bigint;
begin
  select code::uuid into tid from public.nanfu_test_codes where label = 'transfer';
  select count(*) into n from public.nanfu_env_transfers where id = tid;
  if n <> 1 then raise exception 'recipient cannot see the pending transfer'; end if;
  outcome := public.nanfu_env_transfer_respond(tid, true);
  if outcome <> 'accepted' then raise exception 'transfer answer was %', outcome; end if;
  select count(*) into n from public.nanfu_environments;
  if n <> 2 then raise exception 'recipient should own env-c and env-b, saw %', n; end if;
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', true);
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","email":"member@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n bigint;
begin
  select count(*) into n from public.nanfu_environments;
  if n <> 2 then raise exception 'sender still sees the transferred window, count %', n; end if;
  if exists (select 1 from public.nanfu_environments where environment_id = 'env-b') then
    raise exception 'sender still owns env-b after acceptance';
  end if;
end $$;
commit;

-- The recipient is at their quota: a second offered window is refused now, not
-- silently accepted later.
begin;
select set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","email":"admin@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare blocked boolean := false;
begin
  begin
    perform public.nanfu_env_transfer_request('env-g', '88888888-8888-8888-8888-888888888888');
  exception when raise_exception then
    if sqlerrm not like 'NANFU_ENV_QUOTA:%' then raise; end if;
    blocked := true;
  end;
  if not blocked then raise exception 'a transfer over the recipient quota was accepted'; end if;
end $$;
commit;

-- ---------------------------------------------------------------------------
-- 13. Owner force: immediate move, recorded, sender loses access at once.
-- ---------------------------------------------------------------------------

begin;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","email":"owner@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare moved integer; n bigint;
begin
  moved := public.nanfu_env_transfer_batch(
    array['env-b2'],
    '44444444-4444-4444-4444-444444444444',
    '主账号收回'
  );
  if moved <> 1 then raise exception 'bulk transfer moved % windows', moved; end if;
  if (select owner_user_id from public.nanfu_environments where environment_id = 'env-b2')
     <> '44444444-4444-4444-4444-444444444444' then
    raise exception 'window did not move to the owner';
  end if;
  select count(*) into n from public.nanfu_env_transfers
   where environment_id = 'env-b2' and forced and status = 'accepted' and note = '主账号收回';
  if n <> 1 then raise exception 'forced transfer left no record'; end if;
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', true);
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","email":"member@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if exists (select 1 from public.nanfu_environments where environment_id = 'env-b2') then
    raise exception 'sender still sees a forcibly reclaimed window';
  end if;
end $$;
commit;

-- ---------------------------------------------------------------------------
-- 14. Unauthorized management calls fail loudly, never silently.
-- ---------------------------------------------------------------------------

begin;
select set_config('request.jwt.claim.sub', '77777777-7777-7777-7777-777777777777', true);
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","email":"member@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare quota_blocked boolean := false; batch_blocked boolean := false;
begin
  begin
    perform public.nanfu_org_set_quota('66666666-6666-6666-6666-666666666666', 9);
  exception when insufficient_privilege then
    quota_blocked := true;
  end;
  begin
    perform public.nanfu_env_transfer_batch(array['env-g'], '77777777-7777-7777-7777-777777777777', 'x');
  exception when insufficient_privilege then
    batch_blocked := true;
  end;
  if not quota_blocked then raise exception 'a member changed another quota'; end if;
  if not batch_blocked then raise exception 'a member forced a batch transfer'; end if;
end $$;
commit;

-- ---------------------------------------------------------------------------
-- 15. Removing a member: windows return to the owner, the account sees nothing.
-- ---------------------------------------------------------------------------

begin;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","email":"owner@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare moved integer; n bigint;
begin
  moved := public.nanfu_org_remove_member('88888888-8888-8888-8888-888888888888', true);
  if moved <> 2 then raise exception 'removing a member reclaimed % windows', moved; end if;
  select count(*) into n from public.nanfu_environments
   where environment_id in ('env-b', 'env-c')
     and owner_user_id = '44444444-4444-4444-4444-444444444444';
  if n <> 2 then raise exception 'reclaimed windows did not reach the owner'; end if;
  select count(*) into n from public.nanfu_org_members
   where user_id = '88888888-8888-8888-8888-888888888888';
  if n <> 0 then raise exception 'removed member row survived'; end if;
  select count(*) into n from public.nanfu_org_group_grants
   where user_id = '88888888-8888-8888-8888-888888888888';
  if n <> 0 then raise exception 'removed member kept group grants'; end if;
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '88888888-8888-8888-8888-888888888888', true);
select set_config('request.jwt.claims', '{"sub":"88888888-8888-8888-8888-888888888888","email":"member2@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n bigint; blocked boolean := false;
begin
  select count(*) into n from public.nanfu_environments;
  if n <> 0 then raise exception 'removed member still reads % windows', n; end if;
  begin
    perform public.nanfu_org_overview();
  exception when insufficient_privilege then
    blocked := true;
  end;
  if not blocked then raise exception 'removed member still uses the organization RPCs'; end if;
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '66666666-6666-6666-6666-666666666666', true);
select set_config('request.jwt.claims', '{"sub":"66666666-6666-6666-6666-666666666666","email":"manager@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n bigint;
begin
  select count(*) into n from public.nanfu_environments;
  if n <> 1 then raise exception 'manager still sees the removed subordinate, count %', n; end if;
end $$;
commit;

-- ---------------------------------------------------------------------------
-- 16. Free tier: an orphan account self-joins the default workspace, 0 means
--     unlimited, an administrator is never bound by env_quota, and a
--     self-created organization starts under the organization ceiling default.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('99999999-9999-9999-9999-999999999999', 'default-owner@example.com'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'self-joined@example.com'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'capped-admin@example.com'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'solo@example.com')
on conflict (id) do nothing;

-- The operator provisions the default workspace with this fixed id; recreate it
-- as the table owner, uncapped, with its owner attached as a member row so the
-- security-definer RPCs can see an administrator.
insert into public.nanfu_orgs (id, owner_user_id, name, plan_env_max)
values ('a21d2387-127a-4116-aedd-c16164ef1e58', '99999999-9999-9999-9999-999999999999', '默认组织', 0)
on conflict (id) do nothing;

insert into public.nanfu_org_roles (org_id, name, permissions, is_system)
values ('a21d2387-127a-4116-aedd-c16164ef1e58', '成员', array['env.create', 'env.delete', 'env.transfer'], true)
on conflict (org_id, name) do nothing;

insert into public.nanfu_org_members (org_id, user_id, email, identity, env_quota)
values ('a21d2387-127a-4116-aedd-c16164ef1e58', '99999999-9999-9999-9999-999999999999', 'default-owner@example.com', 'owner', 0)
on conflict (user_id) do nothing;

begin;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","email":"self-joined@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare joined uuid; member public.nanfu_org_members;
begin
  joined := public.nanfu_org_self_join();
  if joined <> 'a21d2387-127a-4116-aedd-c16164ef1e58' then raise exception 'self-join returned %', joined; end if;
  select * into member from public.nanfu_org_members where user_id = auth.uid();
  if member.identity <> 'member' then raise exception 'self-join granted the % identity', member.identity; end if;
  if member.env_quota <> 20 then raise exception 'a free member starts with % windows', member.env_quota; end if;
  if member.email <> 'self-joined@example.com' then raise exception 'self-join lost the account email'; end if;
  if member.manager_user_id <> '99999999-9999-9999-9999-999999999999' then
    raise exception 'self-join did not pin the manager to the organization owner';
  end if;
  if member.role_id is null or not exists (
    select 1 from public.nanfu_org_roles r where r.id = member.role_id and r.name = '成员'
  ) then raise exception 'self-join did not assign the built-in member role'; end if;
  -- The client calls this on every sign-in and after a failed refresh, so a
  -- second call must hand back the same organization instead of failing.
  if public.nanfu_org_self_join() <> joined then raise exception 'self-join is not idempotent'; end if;
end $$;
commit;

-- An account that already belongs somewhere keeps its own organization.
begin;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","email":"owner@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare own uuid;
begin
  select id into own from public.nanfu_orgs where owner_user_id = auth.uid();
  if public.nanfu_org_self_join() <> own then raise exception 'self-join moved an existing member'; end if;
end $$;
commit;

-- A capped administrator keeps creating windows: only the organization ceiling
-- binds it. The invite path is what turns bbbb into an administrator.
begin;
select set_config('request.jwt.claim.sub', '99999999-9999-9999-9999-999999999999', true);
select set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999999","email":"default-owner@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  insert into public.nanfu_test_codes (label, code)
  select 'default-admin-invite', public.nanfu_org_create_invite('admin', null, 1);
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', true);
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","email":"capped-admin@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare code text;
begin
  select public.nanfu_org_redeem_invite(c.code) into code from public.nanfu_test_codes c where c.label = 'default-admin-invite';
  if code <> 'a21d2387-127a-4116-aedd-c16164ef1e58' then raise exception 'administrator invite joined %', code; end if;
  if (select env_quota from public.nanfu_org_members where user_id = auth.uid()) <> 1 then
    raise exception 'the invite did not carry the one-window allowance';
  end if;
  -- Three windows on an allowance of one: the administrator path returns before
  -- env_quota is ever read.
  insert into public.nanfu_environments (owner_user_id, org_id, environment_id, payload)
  values (auth.uid(), 'a21d2387-127a-4116-aedd-c16164ef1e58', 'admin-1', '{"v":1,"ct":"YQ=="}'),
         (auth.uid(), 'a21d2387-127a-4116-aedd-c16164ef1e58', 'admin-2', '{"v":1,"ct":"Yg=="}'),
         (auth.uid(), 'a21d2387-127a-4116-aedd-c16164ef1e58', 'admin-3', '{"v":1,"ct":"Yw=="}');
end $$;
commit;

-- A plain member is bound, and the same member is unbound again at 0.
begin;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","email":"self-joined@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  insert into public.nanfu_environments (owner_user_id, org_id, environment_id, payload)
  values (auth.uid(), 'a21d2387-127a-4116-aedd-c16164ef1e58', 'free-1', '{"v":1,"ct":"ZA=="}'),
         (auth.uid(), 'a21d2387-127a-4116-aedd-c16164ef1e58', 'free-2', '{"v":1,"ct":"ZQ=="}');
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '99999999-9999-9999-9999-999999999999', true);
select set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999999","email":"default-owner@example.com","role":"authenticated"}', true);
set local role authenticated;
select public.nanfu_org_set_quota('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 2);
commit;

begin;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","email":"self-joined@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare blocked boolean := false;
begin
  begin
    insert into public.nanfu_environments (owner_user_id, org_id, environment_id, payload)
    values (auth.uid(), 'a21d2387-127a-4116-aedd-c16164ef1e58', 'free-3', '{"v":1,"ct":"Zg=="}');
  exception when raise_exception then
    if sqlerrm not like 'NANFU_ENV_QUOTA:%' then raise; end if;
    blocked := true;
  end;
  if not blocked then raise exception 'a member created a third window on an allowance of two'; end if;
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', '99999999-9999-9999-9999-999999999999', true);
select set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999999","email":"default-owner@example.com","role":"authenticated"}', true);
set local role authenticated;
select public.nanfu_org_set_quota('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 0);
commit;

begin;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","email":"self-joined@example.com","role":"authenticated"}', true);
set local role authenticated;
insert into public.nanfu_environments (owner_user_id, org_id, environment_id, payload)
values (auth.uid(), 'a21d2387-127a-4116-aedd-c16164ef1e58', 'free-3', '{"v":1,"ct":"Zg=="}');
do $$
declare n bigint;
begin
  select count(*) into n from public.nanfu_environments
   where owner_user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and org_id = 'a21d2387-127a-4116-aedd-c16164ef1e58';
  if n <> 3 then raise exception 'an allowance of 0 should be unlimited, windows %', n; end if;
end $$;
commit;

-- A self-created organization starts at the default ceiling.
begin;
select set_config('request.jwt.claim.sub', 'cccccccc-cccc-cccc-cccc-cccccccccccc', true);
select set_config('request.jwt.claims', '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","email":"solo@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare own uuid; cap integer;
begin
  own := public.nanfu_org_create('个人团队');
  select plan_env_max into cap from public.nanfu_orgs where id = own;
  if cap <> 20 then raise exception 'a new organization defaults to a ceiling of %', cap; end if;
  insert into public.nanfu_test_codes (label, code) values ('solo-org', own::text);
end $$;
commit;

-- The ceiling is lowered by the operator (an authenticated role has no UPDATE
-- policy on nanfu_orgs), and it still binds the organization owner.
update public.nanfu_orgs set plan_env_max = 1
 where id = (select code::uuid from public.nanfu_test_codes where label = 'solo-org');

begin;
select set_config('request.jwt.claim.sub', 'cccccccc-cccc-cccc-cccc-cccccccccccc', true);
select set_config('request.jwt.claims', '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","email":"solo@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare own uuid; blocked boolean := false;
begin
  select code::uuid into own from public.nanfu_test_codes where label = 'solo-org';
  insert into public.nanfu_environments (owner_user_id, org_id, environment_id, payload)
  values (auth.uid(), own, 'solo-1', '{"v":1,"ct":"Zw=="}');
  begin
    insert into public.nanfu_environments (owner_user_id, org_id, environment_id, payload)
    values (auth.uid(), own, 'solo-2', '{"v":1,"ct":"aA=="}');
  exception when raise_exception then
    if sqlerrm not like 'NANFU_ORG_QUOTA:%' then raise; end if;
    blocked := true;
  end;
  if not blocked then raise exception 'the organization ceiling did not bind its owner'; end if;
end $$;
commit;

-- A seat taken by nanfu_org_self_join closes the invite path, so a client that
-- redeems invites must do it before falling back to the default workspace.
begin;
select set_config('request.jwt.claim.sub', '99999999-9999-9999-9999-999999999999', true);
select set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999999","email":"default-owner@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  insert into public.nanfu_test_codes (label, code)
  select 'late-invite', public.nanfu_org_create_invite('member', null, 5);
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub', 'cccccccc-cccc-cccc-cccc-cccccccccccc', true);
select set_config('request.jwt.claims', '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","email":"solo@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare blocked boolean := false;
begin
  begin
    perform public.nanfu_org_redeem_invite((select code from public.nanfu_test_codes where label = 'late-invite'));
  exception when others then
    -- The refusal arrives as SQLSTATE 42501, not P0001, so match on the text.
    if sqlerrm not like 'NANFU_FORBIDDEN: this account already belongs to an organization%' then raise; end if;
    blocked := true;
  end;
  if not blocked then raise exception 'an account with an organization redeemed a second invite'; end if;
  if (select count(*) from public.nanfu_org_members
      where user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc') <> 1 then
    raise exception 'the refused redeem moved the account';
  end if;
end $$;
commit;

drop table if exists public.nanfu_test_codes;

-- ---------------------------------------------------------------------------
-- Stopping an employee who still holds windows is refused until the windows
-- are reclaimed; the reclaim moves them to the owner and the name sticks.
-- ---------------------------------------------------------------------------
begin;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","email":"owner@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare blocked boolean := false; held bigint; label text;
begin
  begin
    perform public.nanfu_org_set_member('55555555-5555-5555-5555-555555555555', null, null, null, 'disabled', null);
  exception when others then
    if sqlerrm not like 'NANFU_ENV_HELD:%' then raise; end if;
    blocked := true;
  end;
  if not blocked then raise exception 'an employee holding windows was disabled without reclaiming'; end if;
  perform public.nanfu_org_set_member('55555555-5555-5555-5555-555555555555', null, null, null, 'disabled', null, '仓库管理员', true);
  select count(*) into held from public.nanfu_environments
   where owner_user_id = '44444444-4444-4444-4444-444444444444'
     and environment_id in ('env-g', 'env-x');
  if held <> 2 then raise exception 'reclaiming on disable moved % windows', held; end if;
  select display_name into label from public.nanfu_org_overview()
   where user_id = '55555555-5555-5555-5555-555555555555';
  if label is distinct from '仓库管理员' then raise exception 'display name did not stick: %', label; end if;
end $$;
commit;


-- ---------------------------------------------------------------------------
-- Releases: anonymous cannot read the table; the service role can. Downloads
-- are only issued as signed URLs by the nanfu-release Edge Function.
-- ---------------------------------------------------------------------------
begin;
set local role anon;
do $$
declare n bigint;
begin
  begin
    select count(*) into n from public.nanfu_releases;
    if n <> 0 then raise exception 'anon read % release rows', n; end if;
  exception when insufficient_privilege then
    null; -- no table grant at all is equally unreadable
  end;
end $$;
commit;

begin;
set local role service_role;
insert into public.nanfu_releases
  (version, platform, file_name, object_key, byte_size, sha256)
values
  ('0.1.0-beta.70', 'win-x64', 'Nanfu-setup.exe',
   'releases/0.1.0-beta.70/win-x64/Nanfu-setup.exe', 1024, repeat('a', 64))
on conflict (object_key) do update set byte_size = excluded.byte_size;
do $$
declare n bigint;
begin
  select count(*) into n from public.nanfu_releases where platform = 'win-x64';
  if n <> 1 then
    raise exception 'service_role should read the release row, saw %', n;
  end if;
end $$;
commit;

-- ---------------------------------------------------------------------------
-- Sign-in names: an address account may pick the name it signs in with, while
-- a sub-account keeps the one an administrator assigned.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('99999999-9999-9999-9999-999999999991', 'self@example.com'),
  ('99999999-9999-9999-9999-999999999992', 'other@example.com'),
  ('99999999-9999-9999-9999-999999999993', 'zhangsan@nanfu.local')
on conflict (id) do nothing;

begin;
select set_config('request.jwt.claim.sub', '99999999-9999-9999-9999-999999999991', true);
select set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999991","email":"self@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare failed text;
begin
  if public.nanfu_login_set_name('  SelfName ') <> 'selfname' then
    raise exception 'a chosen name was not stored in lower case';
  end if;
  if public.nanfu_login_name_me() <> 'selfname' then
    raise exception 'the chosen name did not read back';
  end if;
  if public.nanfu_login_resolve('selfname') <> 'self@example.com' then
    raise exception 'the chosen name did not resolve to its address';
  end if;
  if public.nanfu_login_resolve('SELFNAME') <> 'self@example.com' then
    raise exception 'resolving is case sensitive';
  end if;
  if public.nanfu_login_resolve('nobody-at-all') is not null then
    raise exception 'an unused name resolved to an address';
  end if;

  -- Short, dotted at the start, spaced or empty names are all refused.
  foreach failed in array array['a', '.abc', 'zhang san', '', 'zhang/../san'] loop
    begin
      perform public.nanfu_login_set_name(failed);
      raise exception 'invalid name % was accepted', quote_literal(failed);
    exception when others then
      if sqlerrm not like 'NANFU_LOGIN_INVALID%' then
        raise exception 'invalid name % failed for the wrong reason: %', quote_literal(failed), sqlerrm;
      end if;
    end;
  end loop;

  -- An administrator already handed out zhangsan to a sub-account, so the name
  -- must stay unavailable even though it is not in the chosen-name table.
  begin
    perform public.nanfu_login_set_name('zhangsan');
    raise exception 'a name shadowing an assigned login was accepted';
  exception when others then
    if sqlerrm not like 'NANFU_LOGIN_TAKEN%' then raise; end if;
  end;

  if public.nanfu_login_set_name('lisi') <> 'lisi' then
    raise exception 'renaming did not return the new name';
  end if;
  if public.nanfu_login_resolve('selfname') is not null then
    raise exception 'the previous name still resolves';
  end if;
  if public.nanfu_login_resolve('lisi') <> 'self@example.com' then
    raise exception 'the new name does not resolve';
  end if;
end $$;
commit;

-- A name is unique across the whole service, so a second account cannot take it.
begin;
select set_config('request.jwt.claim.sub', '99999999-9999-9999-9999-999999999992', true);
select set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999992","email":"other@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    perform public.nanfu_login_set_name('lisi');
    raise exception 'two accounts share one sign-in name';
  exception when others then
    if sqlerrm not like 'NANFU_LOGIN_TAKEN%' then raise; end if;
  end;
  if public.nanfu_login_name_me() is not null then
    raise exception 'the refused name was stored anyway';
  end if;
end $$;
commit;

-- An account created by an administrator keeps the assigned login.
begin;
select set_config('request.jwt.claim.sub', '99999999-9999-9999-9999-999999999993', true);
select set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999993","email":"zhangsan@nanfu.local","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    perform public.nanfu_login_set_name('zhangsan-new');
    raise exception 'a sub-account renamed itself';
  exception when others then
    if sqlerrm not like 'NANFU_LOGIN_MANAGED%' then raise; end if;
  end;
  begin
    perform public.nanfu_login_clear_name();
    raise exception 'a sub-account cleared its assigned login';
  exception when others then
    if sqlerrm not like 'NANFU_LOGIN_MANAGED%' then raise; end if;
  end;
  if public.nanfu_login_name_me() is not null then
    raise exception 'a sub-account holds a chosen name';
  end if;
end $$;
commit;

-- Signing in happens before any token exists, so resolving is open to anon while
-- setting a name stays closed to it.
begin;
set local role anon;
do $$
begin
  if public.nanfu_login_resolve('lisi') <> 'self@example.com' then
    raise exception 'anon could not resolve a sign-in name';
  end if;
  begin
    perform public.nanfu_login_set_name('anon-name');
    raise exception 'anon chose a sign-in name';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.nanfu_login_name_me();
    raise exception 'anon read a sign-in name';
  exception when insufficient_privilege then
    null;
  end;
end $$;
commit;

-- ---------------------------------------------------------------------------
-- 12. Personal cloud slots: the same account's devices, nobody else's.
--     Seeded as the owner (bypasses RLS) so the policies are what is tested.
-- ---------------------------------------------------------------------------
delete from public.nanfu_cloud_packages where user_id = '11111111-1111-1111-1111-111111111111';
delete from public.nanfu_device_keys where user_id = '11111111-1111-1111-1111-111111111111';
insert into public.nanfu_device_keys (user_id, device_id, public_key)
values
  ('11111111-1111-1111-1111-111111111111', 'device-a', repeat('A', 44));
insert into public.nanfu_cloud_packages
  (id, user_id, environment_id, environment_name, device_id, payload, size_bytes)
values
  ('bbbbbbbb-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'personal-1', 'Mail box', 'device-a', '{"v":2,"alg":"devices","boxes":[],"ct":"Y2lwaGVy"}', 4096);

-- The owner reads their own slot, key and sealed payload.
begin;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"sender@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n bigint; sealed text;
begin
  select count(*) into n from public.nanfu_cloud_packages;
  if n <> 1 then raise exception 'owner saw % own cloud packages', n; end if;
  select payload into sealed from public.nanfu_cloud_packages
   where id = 'bbbbbbbb-0000-0000-0000-000000000001';
  if sealed is null or sealed not like '{"v":2%' then raise exception 'owner could not read their sealed payload'; end if;
  select count(*) into n from public.nanfu_device_keys;
  if n <> 1 then raise exception 'owner saw % own device keys', n; end if;
end $$;
commit;

-- Another account sees nothing, cannot read by id, and cannot steal a row.
begin;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","email":"recipient@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n bigint; changed bigint; blocked boolean := false;
begin
  select count(*) into n from public.nanfu_cloud_packages;
  if n <> 0 then raise exception 'another account listed % foreign cloud packages', n; end if;
  select count(*) into n from public.nanfu_cloud_packages
   where id = 'bbbbbbbb-0000-0000-0000-000000000001';
  if n <> 0 then raise exception 'another account read a cloud package by id'; end if;
  select count(*) into n from public.nanfu_device_keys;
  if n <> 0 then raise exception 'another account read % foreign device keys', n; end if;

  update public.nanfu_cloud_packages set payload = '{"v":2,"ct":"dGFtcGVyZWQ"}'
   where id = 'bbbbbbbb-0000-0000-0000-000000000001';
  get diagnostics changed = row_count;
  if changed <> 0 then raise exception 'another account rewrote a cloud package'; end if;

  delete from public.nanfu_cloud_packages
   where id = 'bbbbbbbb-0000-0000-0000-000000000001';
  get diagnostics changed = row_count;
  if changed <> 0 then raise exception 'another account deleted a cloud package'; end if;

  begin
    insert into public.nanfu_cloud_packages
      (user_id, environment_id, environment_name, device_id, payload)
    values
      ('11111111-1111-1111-1111-111111111111', 'forged', 'Forged', 'device-a', '{"v":2,"ct":"eA"}');
  exception when insufficient_privilege then
    blocked := true;
  end;
  if not blocked then raise exception 'another account wrote into the owner slot'; end if;

  blocked := false;
  begin
    insert into public.nanfu_device_keys (user_id, device_id, public_key)
    values ('11111111-1111-1111-1111-111111111111', 'device-forged', repeat('B', 44));
  exception when insufficient_privilege then
    blocked := true;
  end;
  if not blocked then raise exception 'another account registered a device for the owner'; end if;

  -- Its own row is allowed and stays invisible to the owner above.
  insert into public.nanfu_cloud_packages (user_id, environment_id, device_id, payload)
  values ('22222222-2222-2222-2222-222222222222', 'personal-1', 'device-b', '{"v":2,"ct":"b3du"}');
  select count(*) into n from public.nanfu_cloud_packages;
  if n <> 1 then raise exception 'recipient could not use their own cloud slot'; end if;
end $$;
commit;

-- The sender still sees exactly one row: the recipient's insert leaked nothing.
begin;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"sender@example.com","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n bigint;
begin
  select count(*) into n from public.nanfu_cloud_packages;
  if n <> 1 then raise exception 'owner saw % packages after another account wrote its own', n; end if;
end $$;
commit;

-- Anonymous callers hold no grant at all on either table.
begin;
set local role anon;
do $$
declare blocked boolean := false;
begin
  begin
    perform 1 from public.nanfu_cloud_packages limit 1;
  exception when insufficient_privilege then
    blocked := true;
  end;
  if not blocked then raise exception 'anon read cloud packages'; end if;
  blocked := false;
  begin
    perform 1 from public.nanfu_device_keys limit 1;
  exception when insufficient_privilege then
    blocked := true;
  end;
  if not blocked then raise exception 'anon read device keys'; end if;
end $$;
commit;

select 'nanfu RLS proof passed' as result;

