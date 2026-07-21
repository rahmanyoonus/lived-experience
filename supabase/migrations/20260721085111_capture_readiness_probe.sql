create or replace function public.app_readiness()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'status', 'ready',
    'schema_version', 1,
    'authenticated', auth.uid() is not null
  );
$$;

revoke all on function public.app_readiness() from public;
grant execute on function public.app_readiness() to anon, authenticated, service_role;

comment on function public.app_readiness() is
  'Content-free readiness probe for the browser Data API and current JWT role.';
