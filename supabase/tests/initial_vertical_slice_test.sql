begin;

select plan(43);

select has_table('public', 'stories', 'stories table exists');
select has_table('public', 'audio_segments', 'audio_segments table exists');
select has_table('public', 'original_transcripts', 'original_transcripts table exists');
select has_table('public', 'story_versions', 'story_versions table exists');
select has_table('public', 'migration_receipts', 'migration_receipts table exists');

select is(
  (
    select count(*)
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname in (
        'stories',
        'audio_segments',
        'original_transcripts',
        'story_versions',
        'migration_receipts'
      )
      and relation.relrowsecurity
  ),
  5::bigint,
  'RLS is enabled on every exposed table'
);

select ok(
  not exists (
    select 1
    from information_schema.role_table_grants role_grant
    where role_grant.grantee = 'anon'
      and role_grant.table_schema = 'public'
      and role_grant.table_name in (
        'stories',
        'audio_segments',
        'original_transcripts',
        'story_versions',
        'migration_receipts'
      )
  ),
  'anon has no grants on story tables'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.migrate_guest_story(uuid,uuid,text,timestamp with time zone,boolean,text,text)',
    'execute'
  ),
  'anon cannot call the guest migration RPC'
);

select ok(
  has_table_privilege('authenticated', 'public.stories', 'select'),
  'authenticated users can read RLS-filtered stories'
);

select ok(
  has_column_privilege('authenticated', 'public.original_transcripts', 'id', 'insert'),
  'authenticated owners may preserve a client-generated original transcript id'
);

select ok(
  not has_column_privilege('authenticated', 'public.story_versions', 'id', 'insert')
  and has_function_privilege(
    'authenticated',
    'public.append_story_version(uuid,uuid,text,text,uuid,text)',
    'execute'
  ),
  'authenticated owners preserve client version ids only through the serialised RPC'
);

select ok(
  not has_table_privilege('authenticated', 'public.original_transcripts', 'update')
  and not has_table_privilege('authenticated', 'public.original_transcripts', 'delete'),
  'authenticated clients cannot update or directly delete original transcripts'
);

select ok(
  has_table_privilege('service_role', 'public.original_transcripts', 'insert'),
  'trusted transcription code can insert original transcripts'
);

select ok(
  (
    select function.prosecdef
    from pg_proc function
    join pg_namespace namespace on namespace.oid = function.pronamespace
    where namespace.nspname = 'public'
      and function.proname = 'migrate_guest_story'
  ),
  'guest migration RPC is explicitly secured as SECURITY DEFINER after direct writes are revoked'
);

select results_eq(
  $$
    select bucket.public, bucket.file_size_limit, bucket.allowed_mime_types
    from storage.buckets bucket
    where bucket.id = 'story-audio'
  $$,
  $$ values (false, 52428800::bigint, array['audio/*']::text[]) $$,
  'story-audio is private and constrained to 50 MiB audio uploads'
);

select ok(
  not exists (
    select 1
    from pg_policies policy
    where policy.schemaname = 'storage'
      and policy.tablename = 'objects'
      and 'anon' = any(policy.roles)
  ),
  'anon has no Storage object policy'
);

select ok(
  not exists (
    select 1
    from pg_policies policy
    where policy.schemaname = 'storage'
      and policy.tablename = 'objects'
      and policy.cmd = 'UPDATE'
  ),
  'original audio cannot be overwritten through Storage upsert'
);

-- Synthetic, clearly fictional users and story content only.
insert into auth.users (id, email)
values
  ('10000000-0000-4000-8000-000000000001', 'fictional-one@example.invalid'),
  ('20000000-0000-4000-8000-000000000002', 'fictional-two@example.invalid');

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000001';

select lives_ok(
  $$
    select public.migrate_guest_story(
      '30000000-0000-4000-8000-000000000003'::uuid,
      '40000000-0000-4000-8000-000000000004'::uuid,
      'Yesterday, the fictional clockmaker repaired a blue paper moon.',
      '2026-07-19T08:00:00+08'::timestamptz,
      false,
      null,
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
  $$,
  'an authenticated owner can migrate a non-empty guest draft'
);

select results_eq(
  $$
    select public.migrate_guest_story(
      '30000000-0000-4000-8000-000000000003'::uuid,
      '40000000-0000-4000-8000-000000000004'::uuid,
      'Yesterday, the fictional clockmaker repaired a blue paper moon.',
      '2026-07-19T08:00:00+08'::timestamptz,
      false,
      null,
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
  $$,
  $$ select story_id from public.migration_receipts $$,
  'an identical retry returns the original story id'
);

select results_eq(
  $$ select count(*) from public.stories $$,
  array[1::bigint],
  'idempotent migration creates one story'
);

select results_eq(
  $$ select count(*) from public.story_versions $$,
  array[1::bigint],
  'guest migration creates one recoverable first version'
);

select results_eq(
  $$ select count(*) from public.migration_receipts $$,
  array[1::bigint],
  'idempotent migration creates one receipt'
);

select throws_ok(
  $$
    select public.migrate_guest_story(
      '30000000-0000-4000-8000-000000000003'::uuid,
      '40000000-0000-4000-8000-000000000004'::uuid,
      'A different fictional payload.',
      '2026-07-19T08:00:00+08'::timestamptz,
      false,
      null,
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    )
  $$,
  '22000',
  'idempotency key was retried with a different payload',
  'a retry cannot silently replace the claimed guest payload'
);

select throws_ok(
  $$
    select public.migrate_guest_story(
      '30000000-0000-4000-8000-000000000003'::uuid,
      '50000000-0000-4000-8000-000000000005'::uuid,
      'Another fictional draft.',
      '2026-07-19T08:00:00+08'::timestamptz
    )
  $$,
  '22000',
  'idempotency key belongs to another guest draft',
  'an idempotency key cannot be reused for another guest draft'
);

set local request.jwt.claim.sub = '20000000-0000-4000-8000-000000000002';

select results_eq(
  $$ select count(*) from public.stories $$,
  array[0::bigint],
  'another authenticated user cannot read the first owner''s story'
);

reset role;

set local role service_role;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000001';

select lives_ok(
  $$
    insert into public.audio_segments (
      id,
      story_id,
      owner_id,
      client_segment_id,
      sequence_number,
      duration_ms
    )
    select
      '60000000-0000-4000-8000-000000000006'::uuid,
      story.id,
      story.owner_id,
      '60000000-0000-4000-8000-000000000006'::uuid,
      1,
      12000
    from public.stories story
    where story.owner_id = '10000000-0000-4000-8000-000000000001'::uuid
  $$,
  'the trusted finalisation boundary preserves a stable client-generated audio segment id'
);

reset role;

insert into public.stories (
  id,
  owner_id,
  client_story_id,
  current_text
)
values (
  '80000000-0000-4000-8000-000000000008'::uuid,
  '20000000-0000-4000-8000-000000000002'::uuid,
  '81000000-0000-4000-8000-000000000008'::uuid,
  'The second fictional owner described a green cardboard lighthouse.'
);

insert into public.audio_segments (
  id,
  story_id,
  owner_id,
  client_segment_id,
  sequence_number,
  duration_ms
)
values (
  '90000000-0000-4000-8000-000000000009'::uuid,
  '80000000-0000-4000-8000-000000000008'::uuid,
  '20000000-0000-4000-8000-000000000002'::uuid,
  '91000000-0000-4000-8000-000000000009'::uuid,
  1,
  12000
);

set local role anon;

select throws_ok(
  $$
    insert into public.original_transcripts (
      id,
      story_id,
      owner_id,
      audio_segment_id,
      transcript_text,
      transcription_provider,
      transcription_model
    )
    values (
      'a1000000-0000-4000-8000-00000000000a'::uuid,
      '80000000-0000-4000-8000-000000000008'::uuid,
      '20000000-0000-4000-8000-000000000002'::uuid,
      '90000000-0000-4000-8000-000000000009'::uuid,
      'An anonymous rewrite must not be stored.',
      'synthetic-provider',
      'synthetic-model'
    )
  $$,
  '42501',
  'permission denied for table original_transcripts',
  'anon cannot insert an original transcript'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000001';

select lives_ok(
  $$
    insert into public.original_transcripts (
      id,
      story_id,
      owner_id,
      audio_segment_id,
      transcript_text,
      transcription_provider,
      transcription_model
    )
    select
      'a0000000-0000-4000-8000-00000000000a'::uuid,
      segment.story_id,
      segment.owner_id,
      segment.id,
      'Um, the fictional clock ticked twice.',
      'synthetic-provider',
      'synthetic-model'
    from public.audio_segments segment
    where segment.id = '60000000-0000-4000-8000-000000000006'::uuid
  $$,
  'an owner can migrate an original transcript using only required columns'
);

select results_eq(
  $$ select id from public.original_transcripts $$,
  $$ values ('a0000000-0000-4000-8000-00000000000a'::uuid) $$,
  'original transcript migration preserves its client-generated id'
);

select lives_ok(
  $$
    insert into public.original_transcripts (
      id,
      story_id,
      owner_id,
      audio_segment_id,
      transcript_text,
      transcription_provider,
      transcription_model
    )
    select
      'a0000000-0000-4000-8000-00000000000a'::uuid,
      segment.story_id,
      segment.owner_id,
      segment.id,
      'Um, the fictional clock ticked twice.',
      'synthetic-provider',
      'synthetic-model'
    from public.audio_segments segment
    where segment.id = '60000000-0000-4000-8000-000000000006'::uuid
    on conflict (audio_segment_id) do nothing
  $$,
  'an exact browser retry can use ON CONFLICT DO NOTHING'
);

select results_eq(
  $$ select count(*), min(transcript_text) from public.original_transcripts $$,
  $$ values (1::bigint, 'Um, the fictional clock ticked twice.'::text) $$,
  'an exact retry keeps one unchanged original transcript'
);

select throws_ok(
  $$
    insert into public.original_transcripts (
      id,
      story_id,
      owner_id,
      audio_segment_id,
      transcript_text,
      transcription_provider,
      transcription_model
    )
    select
      'a2000000-0000-4000-8000-00000000000a'::uuid,
      segment.story_id,
      segment.owner_id,
      segment.id,
      'A duplicate must not overwrite the faithful original.',
      'synthetic-provider',
      'synthetic-model'
    from public.audio_segments segment
    where segment.id = '60000000-0000-4000-8000-000000000006'::uuid
    on conflict (audio_segment_id) do update
    set transcript_text = excluded.transcript_text
  $$,
  '42501',
  'permission denied for table original_transcripts',
  'a duplicate cannot overwrite the immutable original transcript'
);

select throws_ok(
  $$
    insert into public.original_transcripts (
      id,
      story_id,
      owner_id,
      audio_segment_id,
      transcript_text,
      transcription_provider,
      transcription_model
    )
    values (
      'b0000000-0000-4000-8000-00000000000b'::uuid,
      '80000000-0000-4000-8000-000000000008'::uuid,
      '20000000-0000-4000-8000-000000000002'::uuid,
      '90000000-0000-4000-8000-000000000009'::uuid,
      'A cross-owner transcript must not be stored.',
      'synthetic-provider',
      'synthetic-model'
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "original_transcripts"',
  'an owner cannot insert a transcript for another owner''s audio'
);

select lives_ok(
  $$
    select public.append_story_version(
      'c0000000-0000-4000-8000-00000000000c'::uuid,
      story.id,
      'The fictional clockmaker added a silver paper star.',
      'manual-edit',
      null,
      null
    )
    from public.stories story
    where story.owner_id = '10000000-0000-4000-8000-000000000001'::uuid
  $$,
  'an owner can migrate a story version with its stable client id'
);

select results_eq(
  $$
    select id
    from public.story_versions
    where version_number = 2
  $$,
  $$ values ('c0000000-0000-4000-8000-00000000000c'::uuid) $$,
  'story version migration preserves its client-generated id'
);

select lives_ok(
  $$
    select public.append_story_version(
      'c0000000-0000-4000-8000-00000000000c'::uuid,
      story.id,
      'The fictional clockmaker added a silver paper star.',
      'manual-edit',
      null,
      null
    )
    from public.stories story
    where story.owner_id = '10000000-0000-4000-8000-000000000001'::uuid
  $$,
  'an exact story-version RPC retry returns the immutable version'
);

select results_eq(
  $$
    select count(*), min(story_text)
    from public.story_versions
    where version_number = 2
  $$,
  $$
    values (
      1::bigint,
      'The fictional clockmaker added a silver paper star.'::text
    )
  $$,
  'an exact retry keeps one unchanged story version'
);

reset role;

delete from public.stories
where id = '80000000-0000-4000-8000-000000000008'::uuid;

select throws_ok(
  $$ update public.audio_segments set duration_ms = duration_ms + 1 $$,
  '55000',
  'public.audio_segments is immutable; insert a new record or delete the parent story',
  'audio segment metadata is immutable'
);

select throws_ok(
  $$ update public.original_transcripts set transcript_text = 'Rewritten.' $$,
  '55000',
  'public.original_transcripts is immutable; insert a new record or delete the parent story',
  'original transcripts are immutable'
);

select throws_ok(
  $$ update public.story_versions set story_text = 'Rewritten.' $$,
  '55000',
  'public.story_versions is immutable; insert a new record or delete the parent story',
  'story versions are immutable'
);

select throws_ok(
  $$ update public.migration_receipts set payload_sha256 = null $$,
  '55000',
  'public.migration_receipts is immutable; insert a new record or delete the parent story',
  'migration receipts are immutable'
);

select ok(
  not has_table_privilege('authenticated', 'public.stories', 'delete')
  and not exists (
    select 1
    from pg_policies policy
    where policy.schemaname = 'storage'
      and policy.tablename = 'objects'
      and policy.cmd = 'DELETE'
      and 'authenticated' = any(policy.roles)
  ),
  'authenticated clients cannot perform a one-sided story or audio deletion'
);

set local role service_role;
delete from public.stories;
reset role;

select results_eq(
  $$
    select
      (select count(*) from public.stories)
      + (select count(*) from public.audio_segments)
      + (select count(*) from public.original_transcripts)
      + (select count(*) from public.story_versions)
      + (select count(*) from public.migration_receipts)
  $$,
  array[0::bigint],
  'story deletion cascades through private database artefacts'
);

select * from finish();
rollback;
