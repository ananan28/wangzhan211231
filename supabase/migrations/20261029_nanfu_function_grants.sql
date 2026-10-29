begin;

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
