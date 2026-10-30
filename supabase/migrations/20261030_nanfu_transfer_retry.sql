-- Retry an accepted encrypted receipt only as its pinned recipient. Applying
-- this after the base schema preserves the existing function owner and ACL;
-- no table policies, grants, or transfer guard triggers are changed.
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

  -- Authorize before disclosing status or expiry. Email never overrides a pin,
  -- nor claims an accepted receipt whose recipient was subsequently deleted.
  -- Coalesce prevents a NULL recipient comparison from admitting a stranger.
  if not coalesce(
       row.recipient_id = caller
       or (row.recipient_id is null and row.status <> 'accepted'
           and lower(row.recipient_email) = caller_email),
       false
     ) then
    raise exception 'this transfer is not addressed to you' using errcode = '42501';
  end if;

  if row.status = 'accepted' and row.recipient_id = caller then
    -- Acceptance already committed: do not UPDATE (or re-check offer expiry).
    return query
      select row.environment_id, row.environment_name, row.payload,
             row.sender_email, row.accepted_at;
    return;
  end if;

  if row.status <> 'pending' then
    raise exception 'this transfer is no longer pending' using errcode = 'P0001';
  end if;
  if row.expires_at <= now() then
    raise exception 'this transfer has expired' using errcode = 'P0001';
  end if;

  -- Keep the row lock and the existing guard trigger on the one state change.
  update public.nanfu_transfers t
     set status = 'accepted', recipient_id = caller, accepted_at = now()
   where t.id = p_id and t.status = 'pending' and t.expires_at > now()
     and (t.recipient_id = caller
          or (t.recipient_id is null and lower(t.recipient_email) = caller_email))
  returning t.* into row;
  if not found then
    raise exception 'this transfer is no longer pending' using errcode = 'P0001';
  end if;

  return query
    select row.environment_id, row.environment_name, row.payload,
           row.sender_email, row.accepted_at;
end;
$$;
