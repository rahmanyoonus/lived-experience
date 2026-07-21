begin;

select plan(47);

select has_table(
  'public',
  'audio_segment_parts',
  'ordered standalone audio parts have their own immutable table'
);

select has_table(
  'public',
  'story_edit_conflicts',
  'concurrent story edits have a durable conflict table'
);

select ok(
  not exists (
    select 1
    from information_schema.columns column_definition
    where column_definition.table_schema = 'public'
      and column_definition.table_name in (
        'audio_segment_parts',
        'audio_upload_part_reservations'
      )
      and column_definition.column_name = 'audio_sha256'
      and column_definition.is_nullable = 'YES'
  ),
  'final and reserved audio parts require a SHA-256 digest'
);

select results_eq(
  $$
    select per_account_quota_bytes
    from private.audio_storage_policy
    where singleton
  $$,
  $$ values (750000000::bigint) $$,
  'the hackathon deployment cap is exactly 750 decimal MB per account'
);

select lives_ok(
  $$
    update private.audio_storage_policy
    set per_account_quota_bytes = 2000000000
    where singleton
  $$,
  'the deployment owner can raise the cap to 2 decimal GB later without a schema change'
);

select results_eq(
  $$
    update private.audio_storage_policy
    set per_account_quota_bytes = 750000000
    where singleton
    returning per_account_quota_bytes
  $$,
  $$ values (750000000::bigint) $$,
  'the test restores the approved 750 MB cap'
);

select ok(
  not exists (
    select 1
    from pg_policies policy
    where policy.schemaname = 'public'
      and policy.policyname in (
        'owners can edit their stories',
        'owners can create their stories',
        'owners can append their audio metadata',
        'owners can append their story versions',
        'owners can append their migration receipts'
      )
  ),
  'obsolete direct-write policies are removed'
);

select ok(
  not has_column_privilege('authenticated', 'public.stories', 'owner_id', 'insert')
  and not has_column_privilege('authenticated', 'public.stories', 'current_text', 'update')
  and not has_column_privilege('authenticated', 'public.audio_segments', 'id', 'insert')
  and not has_table_privilege('authenticated', 'public.audio_segment_parts', 'insert')
  and not has_column_privilege('authenticated', 'public.story_versions', 'id', 'insert')
  and not has_column_privilege('authenticated', 'public.migration_receipts', 'owner_id', 'insert'),
  'authenticated clients cannot bypass the quota, version, or compare-and-swap RPCs'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.reserve_audio_upload(uuid,uuid,integer,integer,timestamp with time zone,jsonb)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.finalise_audio_upload(uuid)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.append_story_version(uuid,uuid,text,text,uuid,text)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.commit_story_edit(uuid,text,bigint,uuid,boolean,text)',
    'execute'
  ),
  'anonymous callers cannot use the authenticated persistence RPCs'
);

-- Synthetic, clearly fictional identities and content only.
insert into auth.users (id, email)
values
  ('10000000-0000-4000-8000-000000000001', 'quota-owner@example.invalid'),
  ('20000000-0000-4000-8000-000000000002', 'other-owner@example.invalid');

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000001';

select lives_ok(
  $$
    select public.migrate_guest_story(
      '30000000-0000-4000-8000-000000000003'::uuid,
      '40000000-0000-4000-8000-000000000004'::uuid,
      'The fictional locksmith kept a violet paper key.',
      '2026-07-19T08:00:00+08'::timestamptz,
      false,
      null,
      null
    )
  $$,
  'the owner has one private story for quota and conflict tests'
);

select throws_ok(
  $$
    insert into public.stories (owner_id, client_story_id, current_text)
    values (
      auth.uid(),
      '41000000-0000-4000-8000-000000000004'::uuid,
      'A fabricated fictional story must not bypass migration.'
    )
  $$,
  '42501',
  'permission denied for table stories',
  'authenticated callers cannot fabricate a story row directly'
);

select throws_ok(
  $$
    insert into public.migration_receipts (
      owner_id, idempotency_key, guest_draft_id, story_id, payload_sha256
    )
    select
      auth.uid(),
      '31000000-0000-4000-8000-000000000003'::uuid,
      '42000000-0000-4000-8000-000000000004'::uuid,
      story_id,
      null
    from public.migration_receipts
    limit 1
  $$,
  '42501',
  'permission denied for table migration_receipts',
  'authenticated callers cannot fabricate a migration receipt'
);

select throws_ok(
  $$
    select public.reserve_audio_upload(
      (select story_id from public.migration_receipts limit 1),
      '43000000-0000-4000-8000-000000000004'::uuid,
      1,
      1000,
      '2026-07-19T08:00:30+08'::timestamptz,
      '[{"part_number":1,"media_type":"audio/webm","byte_size":1,"duration_ms":1000,"start_offset_ms":0}]'::jsonb
    )
  $$,
  '22023',
  'invalid audio part input',
  'an audio reservation cannot omit the client-computed SHA-256 digest'
);

select throws_ok(
  $$
    select public.reserve_audio_upload(
      (select story_id from public.migration_receipts limit 1),
      '44000000-0000-4000-8000-000000000004'::uuid,
      1,
      1,
      '2026-07-19T08:00:40+08'::timestamptz,
      jsonb_build_array(
        jsonb_build_object(
          'part_number', 1, 'media_type', 'audio/webm', 'byte_size', 1,
          'duration_ms', 240000, 'start_offset_ms', 0,
          'audio_sha256', repeat('a', 64)
        ),
        jsonb_build_object(
          'part_number', 2, 'media_type', 'audio/webm', 'byte_size', 1,
          'duration_ms', 240000, 'start_offset_ms', 1560000,
          'audio_sha256', repeat('b', 64)
        )
      )
    )
  $$,
  '22023',
  'audio part timing must be contiguous and equal the logical duration',
  'long containers near thirty minutes cannot claim a one-millisecond logical duration'
);

select throws_ok(
  $$
    select public.reserve_audio_upload(
      (select story_id from public.migration_receipts limit 1),
      '45000000-0000-4000-8000-000000000004'::uuid,
      1,
      2000,
      '2026-07-19T08:00:50+08'::timestamptz,
      jsonb_build_array(
        jsonb_build_object(
          'part_number', 1, 'media_type', 'audio/webm', 'byte_size', 1,
          'duration_ms', 1000, 'start_offset_ms', 0,
          'audio_sha256', repeat('a', 64)
        ),
        jsonb_build_object(
          'part_number', 2, 'media_type', 'audio/webm', 'byte_size', 1,
          'duration_ms', 1000, 'start_offset_ms', 1001,
          'audio_sha256', repeat('b', 64)
        )
      )
    )
  $$,
  '22023',
  'audio part timing must be contiguous and equal the logical duration',
  'ordered part timing cannot contain a gap'
);

select throws_ok(
  $$
    select public.reserve_audio_upload(
      (select story_id from public.migration_receipts limit 1),
      '46000000-0000-4000-8000-000000000004'::uuid,
      1,
      2000,
      '2026-07-19T08:00:55+08'::timestamptz,
      jsonb_build_array(
        jsonb_build_object(
          'part_number', 1, 'media_type', 'audio/webm', 'byte_size', 1,
          'duration_ms', 1000, 'start_offset_ms', 0,
          'audio_sha256', repeat('a', 64)
        ),
        jsonb_build_object(
          'part_number', 2, 'media_type', 'audio/webm', 'byte_size', 1,
          'duration_ms', 1000, 'start_offset_ms', 999,
          'audio_sha256', repeat('b', 64)
        )
      )
    )
  $$,
  '22023',
  'audio part timing must be contiguous and equal the logical duration',
  'ordered part timing cannot overlap'
);

select throws_ok(
  $$
    select public.reserve_audio_upload(
      (select story_id from public.migration_receipts limit 1),
      '50000000-0000-4000-8000-000000000005'::uuid,
      1,
      17000,
      '2026-07-19T08:01:00+08'::timestamptz,
      (
        select jsonb_agg(jsonb_build_object(
          'part_number', part_number,
          'media_type', 'audio/webm',
          'byte_size', 1,
          'duration_ms', 1000,
          'start_offset_ms', (part_number - 1) * 1000,
          'audio_sha256', null
        ) order by part_number)
        from generate_series(1, 17) part_number
      )
    )
  $$,
  '22023',
  'invalid audio reservation input',
  'one logical segment accepts no more than sixteen standalone parts'
);

select lives_ok(
  $$
    select public.reserve_audio_upload(
      (select story_id from public.migration_receipts limit 1),
      '60000000-0000-4000-8000-000000000006'::uuid,
      1,
      2200,
      '2026-07-19T08:02:00+08'::timestamptz,
      jsonb_build_array(
        jsonb_build_object(
          'part_number', 1,
          'media_type', 'audio/webm',
          'byte_size', 5,
          'duration_ms', 1000,
          'start_offset_ms', 0,
          'audio_sha256', repeat('a', 64)
        ),
        jsonb_build_object(
          'part_number', 2,
          'media_type', 'audio/webm',
          'byte_size', 7,
          'duration_ms', 1200,
          'start_offset_ms', 1000,
          'audio_sha256', repeat('b', 64)
        )
      )
    )
  $$,
  'two exact part uploads can be reserved atomically'
);

select results_eq(
  $$
    select part_count, total_byte_size
    from public.audio_upload_reservations
    where client_segment_id = '60000000-0000-4000-8000-000000000006'::uuid
  $$,
  $$ values (2, 12::bigint) $$,
  'the reservation accounts for every byte once'
);

select results_eq(
  $$
    select array_agg(part_number order by part_number),
           array_agg(storage_object_name order by part_number)
    from public.audio_upload_part_reservations
    where client_segment_id = '60000000-0000-4000-8000-000000000006'::uuid
  $$,
  $$
    select
      array[1, 2],
      array[
        '10000000-0000-4000-8000-000000000001/' || story_id::text || '/60000000-0000-4000-8000-000000000006/1.webm',
        '10000000-0000-4000-8000-000000000001/' || story_id::text || '/60000000-0000-4000-8000-000000000006/2.webm'
      ]
    from public.migration_receipts
    limit 1
  $$,
  'part numbers and private object paths are contiguous and deterministic'
);

select throws_ok(
  $$
    insert into storage.objects (
      bucket_id, name, owner, owner_id, metadata, user_metadata
    )
    select
      'story-audio',
      auth.uid()::text || '/' || story_id::text || '/70000000-0000-4000-8000-000000000007/1.webm',
      auth.uid(),
      auth.uid()::text,
      jsonb_build_object('size', 1),
      null
    from public.migration_receipts
    limit 1
  $$,
  '42501',
  'new row violates row-level security policy for table "objects"',
  'Storage rejects an object without an exact active reservation'
);

select ok(
  (
    select policy.with_check like '%audio_upload_part_reservations%'
      and policy.with_check like '%audio_upload_reservations%'
    from pg_policies policy
    where policy.schemaname = 'storage'
      and policy.tablename = 'objects'
      and policy.policyname = 'owners can upload reserved immutable story audio'
  ),
  'Storage upload authorisation requires an exact active reservation'
);

select ok(
  (
    select policy.with_check not like '%user_metadata%'
      and policy.with_check not like '%metadata%'
    from pg_policies policy
    where policy.schemaname = 'storage'
      and policy.tablename = 'objects'
      and policy.policyname = 'owners can upload reserved immutable story audio'
  ),
  'Storage RLS does not depend on metadata populated after object-row creation'
);

select ok(
  exists (
    select 1
    from pg_policies policy
    where policy.schemaname = 'storage'
      and policy.tablename = 'objects'
      and policy.cmd = 'SELECT'
      and policy.roles @> array['authenticated'::name]
  ),
  'Storage can return the newly uploaded private object to its authenticated owner'
);

select lives_ok(
  $$
    insert into storage.objects (
      bucket_id, name, owner, owner_id, metadata, user_metadata
    )
    select
      'story-audio',
      storage_object_name,
      auth.uid(),
      auth.uid()::text,
      jsonb_build_object('size', byte_size),
      jsonb_build_object(
        'audio_sha256', audio_sha256,
        'audio_part_id', id::text,
        'client_segment_id', client_segment_id::text,
        'part_number', part_number::text
      )
    from public.audio_upload_part_reservations
    where client_segment_id = '60000000-0000-4000-8000-000000000006'::uuid
      and part_number = 1
  $$,
  'Storage accepts the first exact reserved part'
);

select lives_ok(
  $$
    insert into storage.objects (
      bucket_id, name, owner, owner_id, metadata, user_metadata
    )
    select
      'story-audio',
      storage_object_name,
      auth.uid(),
      auth.uid()::text,
      jsonb_build_object('size', byte_size),
      jsonb_build_object(
        'audio_sha256', audio_sha256,
        'audio_part_id', id::text,
        'client_segment_id', client_segment_id::text,
        'part_number', part_number::text
      )
    from public.audio_upload_part_reservations
    where client_segment_id = '60000000-0000-4000-8000-000000000006'::uuid
      and part_number = 2
  $$,
  'Storage accepts the second exact reserved part'
);

reset role;
update public.audio_upload_part_reservations
set start_offset_ms = 999
where client_segment_id = '60000000-0000-4000-8000-000000000006'::uuid
  and part_number = 2;
set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000001';

select throws_ok(
  $$
    select public.finalise_audio_upload(
      '60000000-0000-4000-8000-000000000006'::uuid
    )
  $$,
  '22000',
  'audio part timing conflicts with its logical segment',
  'finalisation independently rejects a non-contiguous stored part timeline'
);

reset role;
update public.audio_upload_part_reservations
set start_offset_ms = 1000
where client_segment_id = '60000000-0000-4000-8000-000000000006'::uuid
  and part_number = 2;
update storage.objects object
set user_metadata = jsonb_set(
  object.user_metadata,
  '{audio_sha256}',
  to_jsonb(repeat('f', 64))
)
from public.audio_upload_part_reservations part
where object.bucket_id = 'story-audio'
  and object.name = part.storage_object_name
  and part.client_segment_id = '60000000-0000-4000-8000-000000000006'::uuid
  and part.part_number = 1;
set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000001';

select throws_ok(
  $$
    select public.finalise_audio_upload(
      '60000000-0000-4000-8000-000000000006'::uuid
    )
  $$,
  'LEQ03',
  'uploaded audio parts do not match their reservation',
  'finalisation independently rejects mismatched stored SHA-256 metadata'
);

reset role;
update storage.objects object
set user_metadata = jsonb_set(
  object.user_metadata,
  '{audio_sha256}',
  to_jsonb(part.audio_sha256)
)
from public.audio_upload_part_reservations part
where object.bucket_id = 'story-audio'
  and object.name = part.storage_object_name
  and part.client_segment_id = '60000000-0000-4000-8000-000000000006'::uuid
  and part.part_number = 1;
set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000001';

select lives_ok(
  $$
    select public.finalise_audio_upload(
      '60000000-0000-4000-8000-000000000006'::uuid
    )
  $$,
  'finalisation acknowledges one logical segment only after both parts exist'
);

select results_eq(
  $$
    select
      (select count(*) from public.audio_segments
       where client_segment_id = '60000000-0000-4000-8000-000000000006'::uuid),
      (select count(*) from public.audio_segment_parts
       where audio_segment_id = '60000000-0000-4000-8000-000000000006'::uuid)
  $$,
  $$ values (1::bigint, 2::bigint) $$,
  'finalisation creates one segment and two independently playable parts'
);

select results_eq(
  $$
    with retry as (
      select public.finalise_audio_upload(
        '60000000-0000-4000-8000-000000000006'::uuid
      )
    )
    select
      (select count(*) from public.audio_segments
       where client_segment_id = '60000000-0000-4000-8000-000000000006'::uuid),
      (select count(*) from public.audio_segment_parts
       where audio_segment_id = '60000000-0000-4000-8000-000000000006'::uuid)
    from retry
  $$,
  $$ values (1::bigint, 2::bigint) $$,
  'an acknowledgement retry does not duplicate logical audio or parts'
);

reset role;
delete from private.audio_storage_policy;
set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000001';

select throws_ok(
  $$
    select public.reserve_audio_upload(
      (select story_id from public.migration_receipts limit 1),
      '71000000-0000-4000-8000-000000000007'::uuid,
      2,
      1,
      '2026-07-19T08:03:00+08'::timestamptz,
      jsonb_build_array(jsonb_build_object(
        'part_number', 1, 'media_type', 'audio/webm', 'byte_size', 1,
        'duration_ms', 1, 'start_offset_ms', 0,
        'audio_sha256', repeat('c', 64)
      ))
    )
  $$,
  'LEQ01',
  'audio storage quota is not configured',
  'a missing deployment quota fails closed'
);

reset role;
insert into private.audio_storage_policy (singleton, per_account_quota_bytes)
values (true, 12);
set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000001';

select throws_ok(
  $$
    select public.reserve_audio_upload(
      (select story_id from public.migration_receipts limit 1),
      '72000000-0000-4000-8000-000000000007'::uuid,
      2,
      1,
      '2026-07-19T08:04:00+08'::timestamptz,
      jsonb_build_array(jsonb_build_object(
        'part_number', 1, 'media_type', 'audio/webm', 'byte_size', 1,
        'duration_ms', 1, 'start_offset_ms', 0,
        'audio_sha256', repeat('d', 64)
      ))
    )
  $$,
  'LEQ02',
  'audio storage quota would be exceeded',
  'stored bytes plus reservations cannot exceed the account cap'
);

reset role;
update private.audio_storage_policy set per_account_quota_bytes = 750000000;

select results_eq(
  $$ select per_account_quota_bytes from private.audio_storage_policy $$,
  $$ values (750000000::bigint) $$,
  'the approved cap is restored after failure-path testing'
);

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000001';

select lives_ok(
  $$
    select public.append_story_version(
      'c1000000-0000-4000-8000-00000000000c'::uuid,
      (select story_id from public.migration_receipts limit 1),
      'The fictional locksmith kept the violet paper key beside a silver bell.',
      'cloud-sync',
      null,
      null
    )
  $$,
  'the first editor preserves its complete immutable candidate'
);

select lives_ok(
  $$
    select public.append_story_version(
      'c2000000-0000-4000-8000-00000000000c'::uuid,
      (select story_id from public.migration_receipts limit 1),
      'The fictional locksmith kept the violet paper key beside a green clock.',
      'cloud-sync',
      null,
      null
    )
  $$,
  'the second editor preserves its different immutable candidate'
);

select results_eq(
  $$
    select array_agg(version_number order by version_number)
    from public.story_versions
    where id in (
      'c1000000-0000-4000-8000-00000000000c'::uuid,
      'c2000000-0000-4000-8000-00000000000c'::uuid
    )
  $$,
  $$ values (array[2::bigint, 3::bigint]) $$,
  'the server serialises version numbers without losing either editor'
);

select throws_ok(
  $$
    select public.commit_story_edit(
      (select story_id from public.migration_receipts limit 1),
      'The fictional locksmith kept the violet paper key beside a silver bell.',
      null::bigint,
      'c1000000-0000-4000-8000-00000000000c'::uuid,
      false,
      null
    )
  $$,
  '22023',
  'invalid story edit input',
  'a null expected revision cannot bypass compare-and-swap'
);

select results_eq(
  $$
    select current_text, revision
    from public.stories
    where id = (select story_id from public.migration_receipts limit 1)
  $$,
  $$
    values (
      'The fictional locksmith kept a violet paper key.'::text,
      1::bigint
    )
  $$,
  'the rejected null-revision edit leaves the story unchanged'
);

select results_eq(
  $$
    select public.commit_story_edit(
      (select story_id from public.migration_receipts limit 1),
      'The fictional locksmith kept the violet paper key beside a silver bell.',
      1,
      'c1000000-0000-4000-8000-00000000000c'::uuid,
      false,
      null
    )->>'outcome'
  $$,
  $$ values ('updated'::text) $$,
  'the first candidate is promoted at its acknowledged base revision'
);

select results_eq(
  $$
    select public.commit_story_edit(
      (select story_id from public.migration_receipts limit 1),
      'The fictional locksmith kept the violet paper key beside a green clock.',
      1,
      'c2000000-0000-4000-8000-00000000000c'::uuid,
      false,
      null
    )->>'outcome'
  $$,
  $$ values ('conflict'::text) $$,
  'the stale second candidate becomes an explicit conflict instead of overwriting'
);

select results_eq(
  $$
    select current_text, current_version_id
    from public.stories
    where id = (select story_id from public.migration_receipts limit 1)
  $$,
  $$
    values (
      'The fictional locksmith kept the violet paper key beside a silver bell.'::text,
      'c1000000-0000-4000-8000-00000000000c'::uuid
    )
  $$,
  'the incumbent remains exact and no automatic merge occurs'
);

select results_eq(
  $$
    select count(*)
    from public.story_versions
    where id in (
      'c1000000-0000-4000-8000-00000000000c'::uuid,
      'c2000000-0000-4000-8000-00000000000c'::uuid
    )
  $$,
  $$ values (2::bigint) $$,
  'both competing candidate texts remain recoverable'
);

select results_eq(
  $$ select count(*) from public.story_edit_conflicts $$,
  $$ values (1::bigint) $$,
  'one structured conflict is visible to the owner'
);

select results_eq(
  $$
    with retry as (
      select public.commit_story_edit(
        (select story_id from public.migration_receipts limit 1),
        'The fictional locksmith kept the violet paper key beside a green clock.',
        1,
        'c2000000-0000-4000-8000-00000000000c'::uuid,
        false,
        null
      )
    )
    select count(*) from public.story_edit_conflicts, retry
  $$,
  $$ values (1::bigint) $$,
  'a conflict acknowledgement retry is idempotent'
);

select results_eq(
  $$
    select expected_revision, observed_revision, candidate_version_id
    from public.story_edit_conflicts
  $$,
  $$
    values (
      1::bigint,
      2::bigint,
      'c2000000-0000-4000-8000-00000000000c'::uuid
    )
  $$,
  'the conflict records the stale base, incumbent revision, and candidate identity'
);

set local request.jwt.claim.sub = '20000000-0000-4000-8000-000000000002';

select results_eq(
  $$ select count(*) from public.story_edit_conflicts $$,
  $$ values (0::bigint) $$,
  'another account cannot see the owner''s conflict metadata'
);

select * from finish();
rollback;
