begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Supabase's 2026 Data API defaults make exposure opt-in. Adopt that posture
-- explicitly so this migration behaves the same on older and newer projects.
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from public;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.stories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  client_story_id uuid not null,
  title text,
  current_text text not null default '',
  current_version_id uuid,
  revision bigint not null default 0,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stories_title_length check (
    title is null or char_length(btrim(title)) between 1 and 160
  ),
  constraint stories_revision_nonnegative check (revision >= 0),
  constraint stories_owner_client_story_unique unique (owner_id, client_story_id),
  constraint stories_id_owner_unique unique (id, owner_id),
  constraint stories_id_owner_client_unique unique (id, owner_id, client_story_id)
);

comment on table public.stories is
  'Authenticated users'' private, directly editable story records. Guest drafts never enter this table.';
comment on column public.stories.client_story_id is
  'Stable browser-generated identifier used to make guest-to-account migration retry-safe.';
comment on column public.stories.revision is
  'Server-maintained optimistic-concurrency token incremented on every story update.';

create table public.audio_segments (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null,
  owner_id uuid not null,
  client_segment_id uuid not null,
  sequence_number integer not null,
  storage_object_name text not null,
  media_type text not null,
  byte_size bigint not null,
  duration_ms integer not null,
  audio_sha256 text,
  recorded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint audio_segments_story_owner_fk
    foreign key (story_id, owner_id)
    references public.stories (id, owner_id)
    on delete cascade,
  constraint audio_segments_owner_client_unique unique (owner_id, client_segment_id),
  constraint audio_segments_story_sequence_unique unique (story_id, sequence_number),
  constraint audio_segments_storage_object_unique unique (storage_object_name),
  constraint audio_segments_id_story_owner_unique unique (id, story_id, owner_id),
  constraint audio_segments_sequence_positive check (sequence_number >= 1),
  constraint audio_segments_media_type_audio check (
    char_length(media_type) between 7 and 255
    and lower(media_type) like 'audio/%'
  ),
  constraint audio_segments_byte_size_positive check (byte_size > 0),
  constraint audio_segments_duration_limit check (duration_ms between 1 and 1800000),
  constraint audio_segments_sha256_format check (
    audio_sha256 is null or audio_sha256 ~ '^[0-9A-Fa-f]{64}$'
  ),
  constraint audio_segments_storage_path_matches_row check (
    split_part(storage_object_name, '/', 1) = owner_id::text
    and split_part(storage_object_name, '/', 2) = story_id::text
    and split_part(storage_object_name, '/', 4) = ''
    and split_part(split_part(storage_object_name, '/', 3), '.', 1) = id::text
    and char_length(split_part(split_part(storage_object_name, '/', 3), '.', 2)) between 1 and 10
    and split_part(split_part(storage_object_name, '/', 3), '.', 3) = ''
  )
);

comment on table public.audio_segments is
  'Append-only metadata for one explicit start-to-stop recording. Audio bytes live in the private story-audio bucket.';
comment on column public.audio_segments.duration_ms is
  'Segment duration, capped at the approved 30-minute MVP recording limit.';

create table public.original_transcripts (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null,
  owner_id uuid not null,
  audio_segment_id uuid not null unique,
  transcript_text text not null,
  language_code text not null default 'en',
  uncertainties jsonb not null default '[]'::jsonb,
  transcription_provider text not null,
  transcription_model text not null,
  transcript_sha256 text,
  created_at timestamptz not null default now(),
  constraint original_transcripts_audio_owner_fk
    foreign key (audio_segment_id, story_id, owner_id)
    references public.audio_segments (id, story_id, owner_id)
    on delete cascade,
  constraint original_transcripts_english_only check (language_code = 'en'),
  constraint original_transcripts_uncertainties_array check (
    jsonb_typeof(uncertainties) = 'array'
  ),
  constraint original_transcripts_provider_present check (
    char_length(btrim(transcription_provider)) between 1 and 100
  ),
  constraint original_transcripts_model_present check (
    char_length(btrim(transcription_model)) between 1 and 160
  ),
  constraint original_transcripts_sha256_format check (
    transcript_sha256 is null or transcript_sha256 ~ '^[0-9A-Fa-f]{64}$'
  )
);

comment on table public.original_transcripts is
  'The first faithful transcript for an audio segment. It is immutable and provider provenance is retained.';
comment on column public.original_transcripts.uncertainties is
  'Structured uncertainty ranges for linking doubtful text back to its original audio.';

create table public.story_versions (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null,
  owner_id uuid not null,
  version_number bigint not null,
  story_text text not null,
  reason text not null default 'autosave',
  restored_from_version_id uuid,
  content_sha256 text,
  created_at timestamptz not null default now(),
  constraint story_versions_story_owner_fk
    foreign key (story_id, owner_id)
    references public.stories (id, owner_id)
    on delete cascade,
  constraint story_versions_story_number_unique unique (story_id, version_number),
  constraint story_versions_id_story_owner_unique unique (id, story_id, owner_id),
  constraint story_versions_number_positive check (version_number >= 1),
  constraint story_versions_reason_format check (
    reason ~ '^[a-z][a-z0-9-]{0,31}$'
  ),
  constraint story_versions_sha256_format check (
    content_sha256 is null or content_sha256 ~ '^[0-9A-Fa-f]{64}$'
  ),
  constraint story_versions_restore_same_story_fk
    foreign key (restored_from_version_id, story_id, owner_id)
    references public.story_versions (id, story_id, owner_id)
    on delete restrict
);

comment on table public.story_versions is
  'Append-only recoverable snapshots. Restoring an earlier snapshot inserts another row rather than overwriting history.';

alter table public.stories
  add constraint stories_current_version_fk
  foreign key (current_version_id)
  references public.story_versions (id)
  on delete set null;

create table public.migration_receipts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  idempotency_key uuid not null,
  guest_draft_id uuid not null,
  story_id uuid not null,
  payload_sha256 text,
  created_at timestamptz not null default now(),
  constraint migration_receipts_story_guest_fk
    foreign key (story_id, owner_id, guest_draft_id)
    references public.stories (id, owner_id, client_story_id)
    on delete cascade,
  constraint migration_receipts_owner_key_unique unique (owner_id, idempotency_key),
  constraint migration_receipts_owner_guest_unique unique (owner_id, guest_draft_id),
  constraint migration_receipts_sha256_format check (
    payload_sha256 is null or payload_sha256 ~ '^[0-9A-Fa-f]{64}$'
  )
);

comment on table public.migration_receipts is
  'Append-only receipts proving a browser guest draft was claimed once by its authenticated owner.';

create index stories_owner_updated_at_idx
  on public.stories (owner_id, updated_at desc);
create index audio_segments_story_sequence_idx
  on public.audio_segments (story_id, sequence_number);
create index original_transcripts_story_created_idx
  on public.original_transcripts (story_id, created_at);
create index story_versions_story_version_idx
  on public.story_versions (story_id, version_number desc);
create index migration_receipts_owner_created_idx
  on public.migration_receipts (owner_id, created_at desc);

create function private.touch_story()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  new.revision := old.revision + 1;
  return new;
end;
$$;

create function private.reject_immutable_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = format('%I.%I is immutable; insert a new record or delete the parent story', tg_table_schema, tg_table_name);
end;
$$;

revoke all on function private.touch_story() from public, anon, authenticated;
revoke all on function private.reject_immutable_update() from public, anon, authenticated;

create trigger stories_touch_before_update
before update on public.stories
for each row execute function private.touch_story();

create trigger audio_segments_reject_update
before update on public.audio_segments
for each row execute function private.reject_immutable_update();

create trigger original_transcripts_reject_update
before update on public.original_transcripts
for each row execute function private.reject_immutable_update();

create trigger story_versions_reject_update
before update on public.story_versions
for each row execute function private.reject_immutable_update();

create trigger migration_receipts_reject_update
before update on public.migration_receipts
for each row execute function private.reject_immutable_update();

alter table public.stories enable row level security;
alter table public.audio_segments enable row level security;
alter table public.original_transcripts enable row level security;
alter table public.story_versions enable row level security;
alter table public.migration_receipts enable row level security;

create policy "owners can read their stories"
on public.stories for select
to authenticated
using ((select auth.uid()) = owner_id);

create policy "owners can create their stories"
on public.stories for insert
to authenticated
with check (
  (select auth.uid()) = owner_id
  and current_version_id is null
);

create policy "owners can edit their stories"
on public.stories for update
to authenticated
using ((select auth.uid()) = owner_id)
with check (
  (select auth.uid()) = owner_id
  and (
    current_version_id is null
    or exists (
      select 1
      from public.story_versions version
      where version.id = current_version_id
        and version.story_id = stories.id
        and version.owner_id = (select auth.uid())
    )
  )
);

create policy "owners can read their audio metadata"
on public.audio_segments for select
to authenticated
using ((select auth.uid()) = owner_id);

create policy "owners can append their audio metadata"
on public.audio_segments for insert
to authenticated
with check (
  (select auth.uid()) = owner_id
  and exists (
    select 1
    from public.stories story
    where story.id = audio_segments.story_id
      and story.owner_id = (select auth.uid())
  )
);

create policy "owners can read their original transcripts"
on public.original_transcripts for select
to authenticated
using ((select auth.uid()) = owner_id);

create policy "owners can append their original transcripts"
on public.original_transcripts for insert
to authenticated
with check (
  (select auth.uid()) = owner_id
  and exists (
    select 1
    from public.audio_segments segment
    where segment.id = original_transcripts.audio_segment_id
      and segment.story_id = original_transcripts.story_id
      and segment.owner_id = (select auth.uid())
  )
);

create policy "owners can read their story versions"
on public.story_versions for select
to authenticated
using ((select auth.uid()) = owner_id);

create policy "owners can append their story versions"
on public.story_versions for insert
to authenticated
with check (
  (select auth.uid()) = owner_id
  and exists (
    select 1
    from public.stories story
    where story.id = story_versions.story_id
      and story.owner_id = (select auth.uid())
  )
);

create policy "owners can read their migration receipts"
on public.migration_receipts for select
to authenticated
using ((select auth.uid()) = owner_id);

create policy "owners can append their migration receipts"
on public.migration_receipts for insert
to authenticated
with check (
  (select auth.uid()) = owner_id
  and exists (
    select 1
    from public.stories story
    where story.id = migration_receipts.story_id
      and story.owner_id = (select auth.uid())
      and story.client_story_id = migration_receipts.guest_draft_id
  )
);

-- This RPC is deliberately SECURITY INVOKER. The caller's authenticated role,
-- grants, and RLS policies remain in force while the story, first snapshot, and
-- receipt are created atomically. No privileged bypass is needed.
create function public.migrate_guest_story(
  p_idempotency_key uuid,
  p_guest_story_id uuid,
  p_current_text text,
  p_captured_at timestamptz,
  p_has_audio boolean default false,
  p_title text default null,
  p_payload_sha256 text default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner_id uuid := (select auth.uid());
  v_story_id uuid;
  v_story_text text;
  v_version_id uuid;
  v_receipt_story_id uuid;
  v_receipt_guest_id uuid;
  v_receipt_hash text;
begin
  if v_owner_id is null then
    raise exception using errcode = '42501', message = 'authentication is required';
  end if;

  if p_idempotency_key is null or p_guest_story_id is null then
    raise exception using errcode = '22023', message = 'migration identifiers are required';
  end if;

  if nullif(btrim(coalesce(p_current_text, '')), '') is null and not coalesce(p_has_audio, false) then
    raise exception using errcode = '22023', message = 'a guest story must contain text or audio';
  end if;

  if p_payload_sha256 is not null and p_payload_sha256 !~ '^[0-9A-Fa-f]{64}$' then
    raise exception using errcode = '22023', message = 'payload_sha256 must be a SHA-256 hex digest';
  end if;

  select receipt.story_id, receipt.guest_draft_id, receipt.payload_sha256
    into v_receipt_story_id, v_receipt_guest_id, v_receipt_hash
  from public.migration_receipts receipt
  where receipt.owner_id = v_owner_id
    and receipt.idempotency_key = p_idempotency_key;

  if found then
    if v_receipt_guest_id <> p_guest_story_id then
      raise exception using errcode = '22000', message = 'idempotency key belongs to another guest draft';
    end if;
    if v_receipt_hash is not null and p_payload_sha256 is not null and v_receipt_hash <> p_payload_sha256 then
      raise exception using errcode = '22000', message = 'idempotency key was retried with a different payload';
    end if;
    return v_receipt_story_id;
  end if;

  select receipt.story_id, receipt.payload_sha256
    into v_receipt_story_id, v_receipt_hash
  from public.migration_receipts receipt
  where receipt.owner_id = v_owner_id
    and receipt.guest_draft_id = p_guest_story_id;

  if found then
    if v_receipt_hash is not null and p_payload_sha256 is not null and v_receipt_hash <> p_payload_sha256 then
      raise exception using errcode = '22000', message = 'guest draft was already migrated with a different payload';
    end if;
    return v_receipt_story_id;
  end if;

  insert into public.stories (
    owner_id,
    client_story_id,
    title,
    current_text,
    captured_at
  )
  values (
    v_owner_id,
    p_guest_story_id,
    nullif(btrim(p_title), ''),
    coalesce(p_current_text, ''),
    coalesce(p_captured_at, now())
  )
  on conflict (owner_id, client_story_id) do nothing
  returning id, current_text into v_story_id, v_story_text;

  if v_story_id is null then
    select story.id, story.current_text
      into strict v_story_id, v_story_text
    from public.stories story
    where story.owner_id = v_owner_id
      and story.client_story_id = p_guest_story_id;
  end if;

  insert into public.story_versions (
    story_id,
    owner_id,
    version_number,
    story_text,
    reason
  )
  values (
    v_story_id,
    v_owner_id,
    1,
    v_story_text,
    'guest-migration'
  )
  on conflict (story_id, version_number) do nothing
  returning id into v_version_id;

  if v_version_id is null then
    select version.id
      into strict v_version_id
    from public.story_versions version
    where version.story_id = v_story_id
      and version.version_number = 1;
  end if;

  update public.stories
  set current_version_id = v_version_id
  where id = v_story_id
    and owner_id = v_owner_id
    and current_version_id is null;

  insert into public.migration_receipts (
    owner_id,
    idempotency_key,
    guest_draft_id,
    story_id,
    payload_sha256
  )
  values (
    v_owner_id,
    p_idempotency_key,
    p_guest_story_id,
    v_story_id,
    p_payload_sha256
  )
  on conflict do nothing
  returning story_id into v_receipt_story_id;

  if v_receipt_story_id is null then
    select receipt.story_id, receipt.payload_sha256
      into strict v_receipt_story_id, v_receipt_hash
    from public.migration_receipts receipt
    where receipt.owner_id = v_owner_id
      and receipt.guest_draft_id = p_guest_story_id;

    if v_receipt_hash is not null and p_payload_sha256 is not null and v_receipt_hash <> p_payload_sha256 then
      raise exception using errcode = '22000', message = 'concurrent migration used a different payload';
    end if;
  end if;

  return v_receipt_story_id;
end;
$$;

comment on function public.migrate_guest_story(uuid, uuid, text, timestamptz, boolean, text, text) is
  'Atomically claims one device-local guest draft for auth.uid(); retries return the original story.';

revoke all on table public.stories from anon, authenticated;
revoke all on table public.audio_segments from anon, authenticated;
revoke all on table public.original_transcripts from anon, authenticated;
revoke all on table public.story_versions from anon, authenticated;
revoke all on table public.migration_receipts from anon, authenticated;

grant select on table public.stories to authenticated;
grant insert (owner_id, client_story_id, title, current_text, captured_at)
  on table public.stories to authenticated;
grant update (title, current_text, current_version_id) on table public.stories to authenticated;
grant select on table public.audio_segments to authenticated;
grant insert (
  id,
  story_id,
  owner_id,
  client_segment_id,
  sequence_number,
  storage_object_name,
  media_type,
  byte_size,
  duration_ms,
  audio_sha256,
  recorded_at
) on table public.audio_segments to authenticated;
grant select on table public.original_transcripts to authenticated;
grant insert (
  id,
  story_id,
  owner_id,
  audio_segment_id,
  transcript_text,
  language_code,
  uncertainties,
  transcription_provider,
  transcription_model,
  transcript_sha256
) on table public.original_transcripts to authenticated;
grant select on table public.story_versions to authenticated;
grant insert (
  id,
  story_id,
  owner_id,
  version_number,
  story_text,
  reason,
  restored_from_version_id,
  content_sha256
) on table public.story_versions to authenticated;
grant select on table public.migration_receipts to authenticated;
grant insert (owner_id, idempotency_key, guest_draft_id, story_id, payload_sha256)
  on table public.migration_receipts to authenticated;

grant select, insert, update, delete on table public.stories to service_role;
grant select, insert, delete on table public.audio_segments to service_role;
grant select, insert, delete on table public.original_transcripts to service_role;
grant select, insert, delete on table public.story_versions to service_role;
grant select, insert, delete on table public.migration_receipts to service_role;

revoke all on function public.migrate_guest_story(uuid, uuid, text, timestamptz, boolean, text, text)
  from public, anon;
grant execute on function public.migrate_guest_story(uuid, uuid, text, timestamptz, boolean, text, text)
  to authenticated, service_role;

-- Keep the original recording bucket private in every environment. The local
-- config mirrors these limits; this row ensures db push creates it when hosted.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'story-audio',
  'story-audio',
  false,
  52428800,
  array['audio/*']::text[]
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "owners can download their story audio"
on storage.objects for select
to authenticated
using (
  bucket_id = 'story-audio'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1
    from public.stories story
    where story.owner_id = (select auth.uid())
      and story.id::text = (storage.foldername(name))[2]
  )
);

create policy "owners can upload immutable story audio"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'story-audio'
  and array_length(storage.foldername(name), 1) = 2
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1
    from public.stories story
    where story.owner_id = (select auth.uid())
      and story.id::text = (storage.foldername(name))[2]
  )
);

-- There is intentionally no UPDATE or DELETE policy. A later user-facing delete
-- flow must remove Storage bytes and database metadata as one orchestrated
-- operation after the recovery policy is approved.

commit;
