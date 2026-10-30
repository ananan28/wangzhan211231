begin;

-- Match JavaScript whitespace and C0/C1 controls, independent of database locale.
alter table public.nanfu_login_names drop constraint if exists nanfu_login_names_format;
alter table public.nanfu_login_names add constraint nanfu_login_names_format
  check (name = lower(name) and char_length(name) between 2 and 63
    and name collate "C" !~ U&'[@\0001-\0020\007F-\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]');

create or replace function public.nanfu_org_create_account(
  p_email text,
  p_password text,
  p_identity text default 'member',
  p_quota integer default 0,
  p_parent uuid default null,
  p_role uuid default null,
  p_groups uuid[] default null,
  p_name text default null
)
returns table (user_id uuid, email text, identity text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me public.nanfu_org_members;
  mail text;
  bare_name text;
  parent uuid := p_parent;
  parent_row public.nanfu_org_members;
  new_id uuid := gen_random_uuid();
  plan_max integer;
  allocated integer;
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

  if p_identity is null or p_identity not in ('admin', 'member') then
    raise exception 'NANFU_INPUT: 账号类型只能是管理员或成员' using errcode = 'P0001';
  end if;
  if me.identity not in ('owner', 'admin') then
    if not public.nanfu_org_has_permission(me, 'member.manage') then
      raise exception 'NANFU_FORBIDDEN: 当前角色没有添加子账号的权限' using errcode = '42501';
    end if;
    if p_identity <> 'member' then
      raise exception 'NANFU_FORBIDDEN: 成员只能添加子账号' using errcode = '42501';
    end if;
    parent := me.user_id;
  end if;
  if p_identity = 'admin' and me.identity <> 'owner' then
    raise exception 'NANFU_FORBIDDEN: 只有组织所有者可以添加管理员' using errcode = '42501';
  end if;

  mail := lower(btrim(coalesce(p_email, '')));
  if position('@' in mail) = 0 then
    if char_length(mail) not between 2 and 63
       or mail collate "C" ~ U&'[@\0001-\0020\007F-\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]' then
      raise exception 'NANFU_EMAIL_INVALID: 登录名需为 2 至 63 个字符，支持中文，不能包含空白、@ 或控制字符' using errcode = 'P0001';
    end if;
    bare_name := mail;
    if exists (select 1 from public.nanfu_login_names l where l.name = bare_name) then
      raise exception 'NANFU_LOGIN_TAKEN: 该登录名已被其他账号设为用户名' using errcode = 'P0001';
    end if;
    if exists (select 1 from auth.users u where lower(u.email) = bare_name || '@nanfu.local') then
      raise exception 'NANFU_EMAIL_TAKEN: 该邮箱或登录名已经注册过南孚账号' using errcode = 'P0001';
    end if;
    -- Only ASCII dot-atom local parts keep the legacy address format.
    if mail collate "C" ~ '^[a-z0-9!#$%&''*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&''*+/=?^_`{|}~-]+)*$' then
      mail := mail || '@nanfu.local';
    else
      mail := new_id::text || '@nanfu.local';
    end if;
  elsif char_length(mail) > 320 or mail !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'NANFU_EMAIL_INVALID: 邮箱格式不正确' using errcode = 'P0001';
  end if;
  if p_password is null or char_length(p_password) not between 6 and 12
     or p_password collate "C" ~ '[^!-~]'
     or p_password collate "C" !~ '[A-Za-z]' or p_password !~ '[0-9]' then
    raise exception 'NANFU_PASSWORD_INVALID: 密码需为 6 至 12 位非空白 ASCII 可打印字符，必须包含英文字母和数字，符号可选' using errcode = 'P0001';
  end if;
  if exists (select 1 from auth.users u where lower(u.email) = mail) then
    raise exception 'NANFU_EMAIL_TAKEN: 该邮箱或登录名已经注册过南孚账号' using errcode = 'P0001';
  end if;

  if p_quota is null or p_quota < 0 then
    raise exception 'NANFU_INPUT: 窗口配额不能为负数' using errcode = 'P0001';
  end if;
  select coalesce(o.plan_env_max, 0) into plan_max from public.nanfu_orgs o where o.id = me.org_id;
  if plan_max > 0 and p_quota > 0 then
    select coalesce(sum(greatest(m.env_quota, 0)), 0) into allocated
      from public.nanfu_org_members m
     where m.org_id = me.org_id and m.identity <> 'owner';
    if allocated + p_quota > plan_max then
      raise exception 'NANFU_ORG_QUOTA: 组织剩余可分配配额不足（上限 %，已分配 %）', plan_max, allocated using errcode = 'P0001';
    end if;
  end if;

  if parent is not null then
    select m.* into parent_row from public.nanfu_org_members m
     where m.org_id = me.org_id and m.user_id = parent;
    if not found then
      raise exception 'NANFU_PARENT_INVALID: 上级账号不在本组织内' using errcode = 'P0001';
    end if;
    if parent_row.identity = 'owner' then
      raise exception 'NANFU_PARENT_INVALID: 所有者不能作为上级' using errcode = 'P0001';
    end if;
  end if;
  if p_role is not null and not exists (
    select 1 from public.nanfu_org_roles r where r.id = p_role and r.org_id = me.org_id
  ) then
    raise exception 'NANFU_ROLE_INVALID: 角色不属于当前组织' using errcode = 'P0001';
  end if;
  if p_groups is not null and exists (
    select 1 from unnest(p_groups) g
     where not exists (select 1 from public.nanfu_org_groups x where x.id = g and x.org_id = me.org_id)
  ) then
    raise exception 'NANFU_GROUP_INVALID: 分组不属于当前组织' using errcode = 'P0001';
  end if;
  if p_name is not null and char_length(btrim(p_name)) > 60 then
    raise exception 'NANFU_INPUT: 姓名最多 60 个字符' using errcode = 'P0001';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values (
    coalesce((select u.instance_id from auth.users u where u.id = auth.uid()),
             '00000000-0000-0000-0000-000000000000'::uuid),
    new_id, 'authenticated', 'authenticated', mail,
    extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
    '', '', '', ''
  );

  if bare_name is not null then
    begin
      insert into public.nanfu_login_names (user_id, name) values (new_id, bare_name);
    exception when unique_violation then
      raise exception 'NANFU_LOGIN_TAKEN: 该登录名已被使用' using errcode = 'P0001';
    end;
  end if;

  insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
  values (
    gen_random_uuid(), new_id,
    jsonb_build_object('sub', new_id::text, 'email', mail, 'email_verified', true, 'phone_verified', false),
    'email', new_id::text, null, now(), now()
  );

  insert into public.nanfu_org_members (org_id, user_id, email, display_name, identity, role_id, manager_user_id, env_quota)
  values (me.org_id, new_id, mail, coalesce(nullif(btrim(coalesce(p_name, '')), ''), left(bare_name, 60)), p_identity, p_role, parent, p_quota);

  if p_groups is not null then
    insert into public.nanfu_org_group_grants (group_id, user_id, org_id, granted_by)
    select g, new_id, me.org_id, auth.uid() from unnest(p_groups) g
    on conflict do nothing;
  end if;

  return query select new_id, mail, p_identity;
end;
$$;

create or replace function public.nanfu_org_reset_password(p_user uuid, p_password text)
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
  if p_password is null or char_length(p_password) not between 6 and 12
     or p_password collate "C" ~ '[^!-~]'
     or p_password collate "C" !~ '[A-Za-z]' or p_password !~ '[0-9]' then
    raise exception 'NANFU_PASSWORD_INVALID: 密码需为 6 至 12 位非空白 ASCII 可打印字符，必须包含英文字母和数字，符号可选' using errcode = 'P0001';
  end if;
  select m.* into target from public.nanfu_org_members m
   where m.org_id = me.org_id and m.user_id = p_user;
  if not found then
    raise exception 'NANFU_FORBIDDEN: this account is not in your organization' using errcode = '42501';
  end if;
  if target.identity = 'owner' then
    raise exception 'NANFU_FORBIDDEN: the owner password is not reset here' using errcode = '42501';
  end if;
  if target.identity = 'admin' and me.identity <> 'owner' then
    raise exception 'NANFU_FORBIDDEN: only the owner can reset an administrator' using errcode = '42501';
  end if;
  perform public.nanfu_org_assert_target(me, p_user);
  update auth.users u
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
         updated_at = now()
   where u.id = p_user;
end;
$$;

create or replace function public.nanfu_login_set_name(p_name text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  chosen text := lower(btrim(coalesce(p_name, '')));
  mail text;
begin
  if me is null then
    raise exception 'NANFU_FORBIDDEN: 请先登录' using errcode = '28000';
  end if;
  select lower(u.email) into mail from auth.users u where u.id = me;
  if mail is null then
    raise exception 'NANFU_FORBIDDEN: 账号不存在' using errcode = '42501';
  end if;
  if mail like '%@nanfu.local' then
    raise exception 'NANFU_LOGIN_MANAGED: 子账号的登录名由管理员分配，不能自己修改' using errcode = '42501';
  end if;
  if char_length(chosen) not between 2 and 63
     or chosen collate "C" ~ U&'[@\0001-\0020\007F-\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]' then
    raise exception 'NANFU_LOGIN_INVALID: 用户名需为 2 至 63 个字符，支持中文，不能包含空白、@ 或控制字符' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.nanfu_login_names l where l.name = chosen and l.user_id <> me) then
    raise exception 'NANFU_LOGIN_TAKEN: 该用户名已被使用' using errcode = 'P0001';
  end if;
  if exists (select 1 from auth.users u where lower(u.email) = chosen || '@nanfu.local') then
    raise exception 'NANFU_LOGIN_TAKEN: 该用户名已被使用' using errcode = 'P0001';
  end if;
  begin
    insert into public.nanfu_login_names (user_id, name) values (me, chosen)
    on conflict (user_id) do update set name = excluded.name, updated_at = now();
  exception when unique_violation then
    raise exception 'NANFU_LOGIN_TAKEN: 该用户名已被使用' using errcode = 'P0001';
  end;
  return chosen;
end;
$$;

create or replace function public.nanfu_login_resolve(p_name text)
returns text
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  chosen text := lower(btrim(coalesce(p_name, '')));
  mail text;
begin
  if char_length(chosen) not between 2 and 63
     or chosen collate "C" ~ U&'[@\0001-\0020\007F-\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]' then return null; end if;
  select lower(u.email) into mail
    from public.nanfu_login_names l
    join auth.users u on u.id = l.user_id
   where l.name = chosen;
  return mail;
end;
$$;

commit;
