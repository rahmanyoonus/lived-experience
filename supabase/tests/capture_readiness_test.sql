begin;

select plan(7);

select has_function(
  'public',
  'app_readiness',
  array[]::text[],
  'content-free readiness function exists'
);

select ok(
  not (
    select function.prosecdef
    from pg_proc function
    join pg_namespace namespace on namespace.oid = function.pronamespace
    where namespace.nspname = 'public'
      and function.proname = 'app_readiness'
  ),
  'readiness runs with invoker privileges'
);

select ok(
  not has_function_privilege('public', 'public.app_readiness()', 'execute'),
  'PUBLIC cannot execute readiness implicitly'
);

select ok(
  has_function_privilege('anon', 'public.app_readiness()', 'execute'),
  'anonymous browser clients can probe the Data API'
);

select ok(
  has_function_privilege('authenticated', 'public.app_readiness()', 'execute'),
  'authenticated browser clients can probe the Data API'
);

set local role anon;

select results_eq(
  $$ select public.app_readiness() ->> 'status' $$,
  $$ values ('ready'::text) $$,
  'anonymous readiness reports the database boundary ready'
);

select results_eq(
  $$ select public.app_readiness() ->> 'authenticated' $$,
  $$ values ('false'::text) $$,
  'anonymous readiness never claims an authenticated session'
);

select * from finish();

rollback;
