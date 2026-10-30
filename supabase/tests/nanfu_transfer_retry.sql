-- Local Postgres regression only. Include with \ir nanfu_transfer_retry.sql
-- from nanfu_transfers_rls.sql AFTER its schema/migrations, outside a transaction
-- and before its final success SELECT. Requires the runner's synthetic auth
-- helpers and 20261030_nanfu_transfer_retry.sql; no external services or pgTAP.
-- All fixtures roll back. No grants, policies, triggers or auth helpers change.
\set ON_ERROR_STOP on
begin;

do $$
declare
  sender uuid := 'f3000000-0000-0000-0000-000000000001';
  recipient uuid := 'f3000000-0000-0000-0000-000000000002';
  stranger uuid := 'f3000000-0000-0000-0000-000000000003';
  ids uuid[] := array[
    'f3100000-0000-0000-0000-000000000001', -- live, initially email-addressed
    'f3100000-0000-0000-0000-000000000002', -- accepted, original expiry passed
    'f3100000-0000-0000-0000-000000000003', -- expired pending
    'f3100000-0000-0000-0000-000000000004', -- pending, exact expiry boundary
    'f3100000-0000-0000-0000-000000000005', -- revoked, expiry still future
    'f3100000-0000-0000-0000-000000000006', -- pending, pinned, old email
    'f3100000-0000-0000-0000-000000000007', -- accepted, recipient pin lost
    'f3100000-0000-0000-0000-000000000008'  -- pending, null pin, remains pending
  ]::uuid[];
  target uuid;
  i integer;
  first_receipt record;
  retry_receipt record;
  before_row public.nanfu_transfers;
  after_row public.nanfu_transfers;
  before_ctid tid;
  before_state jsonb;
  after_state jsonb;
  expected_receipt jsonb;
  proc regprocedure := 'public.nanfu_accept_transfer(uuid)'::regprocedure;
begin
  -- CREATE OR REPLACE must keep exactly the existing security posture.
  if not exists (
    select 1 from pg_proc p where p.oid = proc and p.prosecdef
      and p.proconfig = array['search_path=public, pg_temp']
  ) or not has_function_privilege('authenticated', proc, 'EXECUTE')
    or has_function_privilege('anon', proc, 'EXECUTE')
    or exists (
      select 1 from pg_proc p,
        lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = proc and a.grantee = 0 and a.privilege_type = 'EXECUTE'
    ) then
    raise exception 'transfer retry changed SECURITY DEFINER, search_path or execute grants';
  end if;

  -- Seed as the runner's database owner; every RPC below runs under a real
  -- non-owner role. Fixture IDs/emails are private to this rollback-only test.
  insert into auth.users (id, email) values
    (sender, 'retry-sender@fixture.test'),
    (recipient, 'retry-recipient@fixture.test'),
    (stranger, 'retry-stranger@fixture.test');

  insert into public.nanfu_transfers
    (id, sender_id, sender_email, recipient_id, recipient_email,
     environment_id, environment_name, payload, status, created_at, expires_at, accepted_at)
  select ids[v.n], sender, 'retry-sender@fixture.test',
         case when v.n in (2, 6) then recipient else null end,
         case when v.n = 6 then 'old-recipient@fixture.test' else 'RETRY-RECIPIENT@fixture.test' end,
         'retry-env-' || v.n, 'Synthetic receipt ' || v.n,
         '{"v":1,"ct":"c3ludGhldGljLXJldHJ5"}', v.status,
         now() - interval '10 days',
         case when v.n in (2, 3, 7) then now() - interval '3 days'
              when v.n = 4 then now() else now() + interval '1 day' end,
         case when v.status = 'accepted' then now() - interval '9 days' else null end
    from (values (1, 'pending'), (2, 'accepted'), (3, 'pending'), (4, 'pending'),
                 (5, 'revoked'), (6, 'pending'), (7, 'accepted'), (8, 'pending')) v(n, status);

  -- A fresh email-addressed offer is accepted once, with all other fields intact.
  select t.* into strict before_row from public.nanfu_transfers t where t.id = ids[1];
  perform set_config('request.jwt.claim.sub', recipient::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', recipient, 'email', 'retry-recipient@fixture.test', 'role', 'authenticated')::text, true);
  set local role authenticated;
  select * into strict first_receipt from public.nanfu_accept_transfer(ids[1]);
  reset role;
  select t.* into strict after_row from public.nanfu_transfers t where t.id = ids[1];
  if first_receipt.accepted_at is null
     or to_jsonb(after_row) is distinct from
       (to_jsonb(before_row) || jsonb_build_object('status', 'accepted',
          'recipient_id', recipient, 'accepted_at', first_receipt.accepted_at)) then
    raise exception 'first acceptance did not pin the receipt or changed unrelated fields';
  end if;
  expected_receipt := jsonb_build_object(
    'environment_id', before_row.environment_id, 'environment_name', before_row.environment_name,
    'payload', before_row.payload, 'sender_email', before_row.sender_email,
    'accepted_at', after_row.accepted_at);
  if to_jsonb(first_receipt) is distinct from expected_receipt then
    raise exception 'first acceptance returned the wrong receipt';
  end if;

  -- Retry with a changed email: the accepted UUID, not the old email, owns it.
  -- Compare both the full row and ctid: even a no-op UPDATE must not happen.
  before_row := after_row;
  select t.ctid into strict before_ctid from public.nanfu_transfers t where t.id = ids[1];
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', recipient, 'email', 'changed-address@fixture.test', 'role', 'authenticated')::text, true);
  set local role authenticated;
  select * into strict retry_receipt from public.nanfu_accept_transfer(ids[1]);
  if to_jsonb(retry_receipt) is distinct from to_jsonb(first_receipt) then
    raise exception 'retry changed the payload, timestamp or receipt metadata';
  end if;
  if exists (select 1 from public.nanfu_transfers where id = ids[1]) then
    raise exception 'retry expanded recipient SELECT visibility';
  end if;
  reset role;
  if not exists (select 1 from public.nanfu_transfers t
    where t.id = ids[1] and to_jsonb(t) = to_jsonb(before_row) and t.ctid = before_ctid) then
    raise exception 'retry updated the accepted row';
  end if;

  -- now() is transaction-stable, so two immediate calls alone cannot detect a
  -- regenerated timestamp. This historical accepted fixture proves that retry
  -- returns the stored timestamp, including AFTER the original offer expires.
  select t.* into strict before_row from public.nanfu_transfers t where t.id = ids[2];
  select t.ctid into strict before_ctid from public.nanfu_transfers t where t.id = ids[2];
  expected_receipt := jsonb_build_object(
    'environment_id', before_row.environment_id, 'environment_name', before_row.environment_name,
    'payload', before_row.payload, 'sender_email', before_row.sender_email,
    'accepted_at', before_row.accepted_at);
  set local role authenticated;
  select * into strict first_receipt from public.nanfu_accept_transfer(ids[2]);
  select * into strict retry_receipt from public.nanfu_accept_transfer(ids[2]);
  if to_jsonb(first_receipt) is distinct from expected_receipt
     or to_jsonb(retry_receipt) is distinct from expected_receipt then
    raise exception 'post-expiry retry changed the original accepted receipt';
  end if;
  reset role;
  if not exists (select 1 from public.nanfu_transfers t
    where t.id = ids[2] and to_jsonb(t) = to_jsonb(before_row) and t.ctid = before_ctid) then
    raise exception 'post-expiry retry updated the accepted row';
  end if;

  -- All refused calls below must leave every fixture completely untouched.
  select jsonb_agg(jsonb_build_object('row', to_jsonb(t), 'ctid', t.ctid::text) order by t.id)
    into before_state from public.nanfu_transfers t where t.id = any(ids);

  -- Stranger and sender are both non-recipients, regardless of offer status.
  -- Exact 42501/message checks catch premature status/expiry disclosures.
  foreach target in array array[stranger, sender] loop
    perform set_config('request.jwt.claim.sub', target::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object(
      'sub', target, 'email', 'not-the-recipient@fixture.test', 'role', 'authenticated')::text, true);
    set local role authenticated;
    for i in 1..array_length(ids, 1) loop
      begin
        perform public.nanfu_accept_transfer(ids[i]);
        raise exception 'non-recipient accepted fixture %', i;
      exception when insufficient_privilege then
        if sqlerrm <> 'this transfer is not addressed to you' then raise; end if;
      end;
    end loop;
    reset role;
  end loop;

  -- A same-mail stranger cannot override a pending/accepted pin, or recover an
  -- accepted receipt with a NULL pin (e.g. after deletion of its recipient).
  perform set_config('request.jwt.claim.sub', stranger::text, true);
  set local role authenticated;
  foreach i in array array[1, 2, 6, 7] loop
    perform set_config('request.jwt.claims', jsonb_build_object(
      'sub', stranger, 'email', case when i = 6 then 'OLD-RECIPIENT@fixture.test'
        else 'retry-recipient@fixture.test' end, 'role', 'authenticated')::text, true);
    begin
      perform public.nanfu_accept_transfer(ids[i]);
      raise exception 'email fallback stole pinned/orphan accepted fixture %', i;
    exception when insufficient_privilege then
      if sqlerrm <> 'this transfer is not addressed to you' then raise; end if;
    end;
  end loop;
  -- Missing email plus NULL recipient_id must not fall through SQL NULL logic.
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', stranger, 'role', 'authenticated')::text, true);
  begin
    perform public.nanfu_accept_transfer(ids[8]);
    raise exception 'missing email accepted an unpinned transfer';
  exception when insufficient_privilege then
    if sqlerrm <> 'this transfer is not addressed to you' then raise; end if;
  end;
  reset role;

  -- The legitimate addressee still cannot accept expired pending or revoked
  -- offers. The equality boundary is expired, not a fresh acceptance.
  perform set_config('request.jwt.claim.sub', recipient::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', recipient, 'email', 'retry-recipient@fixture.test', 'role', 'authenticated')::text, true);
  set local role authenticated;
  foreach i in array array[3, 4, 5] loop
    begin
      perform public.nanfu_accept_transfer(ids[i]);
      raise exception 'expired/revoked fixture % was accepted', i;
    exception when sqlstate 'P0001' then
      if sqlerrm is distinct from (case when i = 5 then 'this transfer is no longer pending'
           else 'this transfer has expired' end) then raise; end if;
    end;
  end loop;

  -- A caller without an identity is denied even with a matching email;
  -- authentication must run before lookup, status and expiry disclosures.
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"email":"retry-recipient@fixture.test"}', true);
  foreach target in array array_append(ids, 'f3100000-0000-0000-0000-000000000099'::uuid) loop
    begin
      perform public.nanfu_accept_transfer(target);
      raise exception 'a caller without a UID accepted a transfer';
    exception when sqlstate '28000' then
      if sqlerrm <> 'sign in before accepting a transfer' then raise; end if;
    end;
  end loop;
  reset role;

  -- The real anon role lacks EXECUTE even when claims pretend to be the pinned
  -- recipient. This tests the unchanged ACL separately from the UID guard.
  perform set_config('request.jwt.claim.sub', recipient::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', recipient, 'email', 'retry-recipient@fixture.test', 'role', 'anon')::text, true);
  set local role anon;
  foreach target in array ids loop
    begin
      perform public.nanfu_accept_transfer(target);
      raise exception 'anon executed transfer acceptance';
    exception when insufficient_privilege then
      if sqlerrm not like 'permission denied for function nanfu_accept_transfer%' then raise; end if;
    end;
  end loop;
  reset role;

  select jsonb_agg(jsonb_build_object('row', to_jsonb(t), 'ctid', t.ctid::text) order by t.id)
    into after_state from public.nanfu_transfers t where t.id = any(ids);
  if after_state is distinct from before_state then
    raise exception 'a denied call changed transfer state';
  end if;

  -- Pinned pending offers still accept by UUID even when email has changed.
  select t.* into strict before_row from public.nanfu_transfers t where t.id = ids[6];
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', recipient, 'email', 'changed-address@fixture.test', 'role', 'authenticated')::text, true);
  set local role authenticated;
  select * into strict first_receipt from public.nanfu_accept_transfer(ids[6]);
  reset role;
  select t.* into strict after_row from public.nanfu_transfers t where t.id = ids[6];
  if first_receipt.accepted_at is null
     or to_jsonb(after_row) is distinct from
       (to_jsonb(before_row) || jsonb_build_object('status', 'accepted',
          'recipient_id', recipient, 'accepted_at', first_receipt.accepted_at)) then
    raise exception 'pinned pending acceptance changed unrelated state or lost its pin';
  end if;
end;
$$;

rollback;
select 'nanfu transfer retry proof passed' as result;
