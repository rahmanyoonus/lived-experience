begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- The approved hackathon allowance is 750,000,000 bytes per account, leaving
-- explicit headroom beneath Supabase Free's project-wide 1 GB Storage allowance. Removing this
-- singleton row makes reservations fail closed.
create table private.audio_storage_policy (
  singleton boolean primary key default true,
  per_account_quota_bytes bigint not null,
  upload_reservation_ttl interval not null default interval '1 hour',
  updated_at timestamptz not null default now(),
  constraint audio_storage_policy_singleton check (singleton),
  constraint audio_storage_policy_quota_positive check (
    per_account_quota_bytes > 0
  ),
  constraint audio_storage_policy_ttl_range check (
    upload_reservation_ttl between interval '5 minutes' and interval '24 hours'
  )
);

comment on table private.audio_storage_policy is
  'Deployment-owned audio quota. No row means authenticated audio uploads fail closed.';

insert into private.audio_storage_policy (
  singleton,
  per_account_quota_bytes,
  upload_reservation_ttl
)
values (true, 750000000, interval '1 hour');

create table private.audio_storage_accounts (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

comment on table private.audio_storage_accounts is
  'One lock row per owner serialises quota reservations without holding locks across object upload requests.';

create table public.audio_upload_reservations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  story_id uuid not null,
  client_segment_id uuid not null,
  sequence_number integer not null,
  storage_object_name text not null,
  media_type text not null,
  byte_size bigint not null,
  duration_ms integer not null,
  audio_sha256 text,
  recorded_at timestamptz not null,
  expires_at timestamptz not null,
  finalised_at timestamptz,
  created_at timestamptz not null default now(),
  constraint audio_upload_reservations_story_owner_fk
    foreign key (story_id, owner_id)
    references public.stories (id, owner_id)
    on delete cascade,
  constraint audio_upload_reservations_owner_client_unique
    unique (owner_id, client_segment_id),
  constraint audio_upload_reservations_storage_object_unique
    unique (storage_object_name),
  constraint audio_upload_reservations_sequence_positive check (
    sequence_number >= 1
  ),
  constraint audio_upload_reservations_media_type_audio check (
    char_length(media_type) between 7 and 255
    and lower(media_type) like 'audio/%'
  ),
  constraint audio_upload_reservations_byte_size_range check (
    byte_size between 1 and 52428800
  ),
  constraint audio_upload_reservations_duration_limit check (
    duration_ms between 1 and 1800000
  ),
  constraint audio_upload_reservations_sha256_format check (
    audio_sha256 is null or audio_sha256 ~ '^[0-9A-Fa-f]{64}$'
  ),
  constraint audio_upload_reservations_expiry_after_creation check (
    expires_at > created_at
  ),
  constraint audio_upload_reservations_finalised_after_creation check (
    finalised_at is null or finalised_at >= created_at
  ),
  constraint audio_upload_reservations_storage_path_matches_row check (
    split_part(storage_object_name, '/', 1) = owner_id::text
    and split_part(storage_object_name, '/', 2) = story_id::text
    and split_part(storage_object_name, '/', 4) = ''
    and split_part(split_part(storage_object_name, '/', 3), '.', 1) = client_segment_id::text
    and char_length(split_part(split_part(storage_object_name, '/', 3), '.', 2)) between 1 and 10
    and split_part(split_part(storage_object_name, '/', 3), '.', 3) = ''
  )
);

comment on table public.audio_upload_reservations is
  'Short-lived, exact-size authority to upload one immutable private audio object. Finalisation is server-controlled.';

create index audio_upload_reservations_owner_expiry_idx
  on public.audio_upload_reservations (owner_id, expires_at)
  where finalised_at is null;
create index audio_upload_reservations_story_sequence_idx
  on public.audio_upload_reservations (story_id, sequence_number);

alter table public.audio_upload_reservations enable row level security;

create policy "owners can read their audio upload reservations"
on public.audio_upload_reservations for select
to authenticated
using ((select auth.uid()) = owner_id);

revoke all on table public.audio_upload_reservations from anon, authenticated;
grant select on table public.audio_upload_reservations to authenticated;
grant select, insert, update, delete on table public.audio_upload_reservations
  to service_role;

create function private.audio_storage_bytes_for_owner(p_owner_id uuid)
returns bigint
language sql
security invoker
stable
set search_path = ''
as $$
  select
    coalesce((
      select sum(
        case
          when coalesce(object.metadata->>'size', '') ~ '^[0-9]+$'
            then (object.metadata->>'size')::bigint
          else 0
        end
      )
      from storage.objects object
      where object.bucket_id = 'story-audio'
        and split_part(object.name, '/', 1) = p_owner_id::text
    ), 0)::bigint
    +
    coalesce((
      select sum(reservation.byte_size)
      from public.audio_upload_reservations reservation
      where reservation.owner_id = p_owner_id
        and reservation.finalised_at is null
        and reservation.expires_at > clock_timestamp()
        and not exists (
          select 1
          from storage.objects object
          where object.bucket_id = 'story-audio'
            and object.name = reservation.storage_object_name
        )
    ), 0)::bigint;
$$;

revoke all on function private.audio_storage_bytes_for_owner(uuid)
  from public, anon, authenticated;

create function public.reserve_audio_upload(
  p_story_id uuid,
  p_client_segment_id uuid,
  p_preferred_sequence_number integer,
  p_media_type text,
  p_byte_size bigint,
  p_duration_ms integer,
  p_recorded_at timestamptz,
  p_audio_sha256 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid := (select auth.uid());
  v_quota_bytes bigint;
  v_reservation_ttl interval;
  v_used_bytes bigint;
  v_extension text;
  v_media_type text := lower(btrim(p_media_type));
  v_sequence_number integer;
  v_storage_object_name text;
  v_existing public.audio_upload_reservations%rowtype;
  v_result public.audio_upload_reservations%rowtype;
begin
  if v_owner_id is null then
    raise exception using errcode = '42501', message = 'authentication is required';
  end if;

  if p_story_id is null
    or p_client_segment_id is null
    or p_preferred_sequence_number < 1
    or p_byte_size not between 1 and 52428800
    or p_duration_ms not between 1 and 1800000
    or p_recorded_at is null
    or char_length(v_media_type) not between 7 and 255
    or v_media_type not like 'audio/%'
    or (p_audio_sha256 is not null and p_audio_sha256 !~ '^[0-9A-Fa-f]{64}$')
  then
    raise exception using errcode = '22023', message = 'invalid audio reservation input';
  end if;

  v_extension := case split_part(v_media_type, ';', 1)
    when 'audio/webm' then 'webm'
    when 'audio/mp4' then 'm4a'
    when 'audio/ogg' then 'ogg'
    when 'audio/mpeg' then 'mp3'
    when 'audio/wav' then 'wav'
    when 'audio/x-wav' then 'wav'
    else null
  end;
  if v_extension is null then
    raise exception using errcode = '22023', message = 'unsupported audio media type';
  end if;

  if not exists (
    select 1
    from public.stories story
    where story.id = p_story_id
      and story.owner_id = v_owner_id
  ) then
    raise exception using errcode = '42501', message = 'story is unavailable';
  end if;

  insert into private.audio_storage_accounts (owner_id)
  values (v_owner_id)
  on conflict (owner_id) do nothing;

  perform 1
  from private.audio_storage_accounts account
  where account.owner_id = v_owner_id
  for update;

  select policy.per_account_quota_bytes, policy.upload_reservation_ttl
    into v_quota_bytes, v_reservation_ttl
  from private.audio_storage_policy policy
  where policy.singleton;

  if not found then
    raise exception using
      errcode = 'LEQ01',
      message = 'audio storage quota is not configured';
  end if;

  select reservation.*
    into v_existing
  from public.audio_upload_reservations reservation
  where reservation.owner_id = v_owner_id
    and reservation.client_segment_id = p_client_segment_id
  for update;

  if found then
    if v_existing.story_id <> p_story_id
      or v_existing.media_type <> v_media_type
      or v_existing.byte_size <> p_byte_size
      or v_existing.duration_ms <> p_duration_ms
      or v_existing.recorded_at <> p_recorded_at
      or v_existing.audio_sha256 is distinct from lower(p_audio_sha256)
    then
      raise exception using
        errcode = '22000',
        message = 'audio reservation conflicts with an earlier request';
    end if;

    if v_existing.finalised_at is not null
      or v_existing.expires_at > clock_timestamp()
    then
      return to_jsonb(v_existing);
    end if;

    v_used_bytes := private.audio_storage_bytes_for_owner(v_owner_id);
    if not exists (
      select 1
      from storage.objects object
      where object.bucket_id = 'story-audio'
        and object.name = v_existing.storage_object_name
    ) and v_used_bytes + p_byte_size > v_quota_bytes then
      raise exception using
        errcode = 'LEQ02',
        message = 'audio storage quota would be exceeded';
    end if;

    update public.audio_upload_reservations reservation
    set expires_at = clock_timestamp() + v_reservation_ttl
    where reservation.id = v_existing.id
    returning reservation.* into v_result;
    return to_jsonb(v_result);
  end if;

  v_used_bytes := private.audio_storage_bytes_for_owner(v_owner_id);
  if v_used_bytes + p_byte_size > v_quota_bytes then
    raise exception using
      errcode = 'LEQ02',
      message = 'audio storage quota would be exceeded';
  end if;

  v_sequence_number := p_preferred_sequence_number;
  if exists (
    select 1
    from public.audio_segments segment
    where segment.story_id = p_story_id
      and segment.sequence_number = v_sequence_number
  ) or exists (
    select 1
    from public.audio_upload_reservations reservation
    where reservation.story_id = p_story_id
      and reservation.sequence_number = v_sequence_number
  ) then
    select coalesce(max(candidate.sequence_number), 0) + 1
      into v_sequence_number
    from (
      select segment.sequence_number
      from public.audio_segments segment
      where segment.story_id = p_story_id
      union all
      select reservation.sequence_number
      from public.audio_upload_reservations reservation
      where reservation.story_id = p_story_id
    ) candidate;
  end if;

  v_storage_object_name :=
    v_owner_id::text || '/' || p_story_id::text || '/' ||
    p_client_segment_id::text || '.' || v_extension;

  insert into public.audio_upload_reservations (
    owner_id,
    story_id,
    client_segment_id,
    sequence_number,
    storage_object_name,
    media_type,
    byte_size,
    duration_ms,
    audio_sha256,
    recorded_at,
    expires_at
  )
  values (
    v_owner_id,
    p_story_id,
    p_client_segment_id,
    v_sequence_number,
    v_storage_object_name,
    v_media_type,
    p_byte_size,
    p_duration_ms,
    lower(p_audio_sha256),
    p_recorded_at,
    clock_timestamp() + v_reservation_ttl
  )
  returning * into v_result;

  return to_jsonb(v_result);
end;
$$;

comment on function public.reserve_audio_upload(uuid, uuid, integer, text, bigint, integer, timestamptz, text) is
  'Atomically reserves exact private Storage capacity for one owner-bound audio segment. Fails closed until a deployment quota exists.';

create function public.finalise_audio_upload(p_client_segment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid := (select auth.uid());
  v_reservation public.audio_upload_reservations%rowtype;
  v_existing public.audio_segments%rowtype;
  v_result public.audio_segments%rowtype;
  v_object_size bigint;
begin
  if v_owner_id is null then
    raise exception using errcode = '42501', message = 'authentication is required';
  end if;

  select reservation.*
    into v_reservation
  from public.audio_upload_reservations reservation
  where reservation.owner_id = v_owner_id
    and reservation.client_segment_id = p_client_segment_id
  for update;

  if not found then
    raise exception using errcode = '22023', message = 'audio reservation was not found';
  end if;

  select segment.*
    into v_existing
  from public.audio_segments segment
  where segment.owner_id = v_owner_id
    and segment.client_segment_id = p_client_segment_id;

  if found then
    if v_existing.story_id <> v_reservation.story_id
      or v_existing.sequence_number <> v_reservation.sequence_number
      or v_existing.storage_object_name <> v_reservation.storage_object_name
      or v_existing.media_type <> v_reservation.media_type
      or v_existing.byte_size <> v_reservation.byte_size
      or v_existing.duration_ms <> v_reservation.duration_ms
      or v_existing.recorded_at <> v_reservation.recorded_at
      or v_existing.audio_sha256 is distinct from v_reservation.audio_sha256
    then
      raise exception using errcode = '22000', message = 'finalised audio conflicts with its reservation';
    end if;
    return to_jsonb(v_existing);
  end if;

  select case
      when coalesce(object.metadata->>'size', '') ~ '^[0-9]+$'
        then (object.metadata->>'size')::bigint
      else null
    end
    into v_object_size
  from storage.objects object
  where object.bucket_id = 'story-audio'
    and object.name = v_reservation.storage_object_name;

  if v_object_size is null or v_object_size <> v_reservation.byte_size then
    raise exception using
      errcode = 'LEQ03',
      message = 'uploaded audio does not match its reservation';
  end if;

  insert into public.audio_segments (
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
  )
  values (
    v_reservation.client_segment_id,
    v_reservation.story_id,
    v_reservation.owner_id,
    v_reservation.client_segment_id,
    v_reservation.sequence_number,
    v_reservation.storage_object_name,
    v_reservation.media_type,
    v_reservation.byte_size,
    v_reservation.duration_ms,
    v_reservation.audio_sha256,
    v_reservation.recorded_at
  )
  returning * into v_result;

  update public.audio_upload_reservations reservation
  set finalised_at = clock_timestamp()
  where reservation.id = v_reservation.id;

  return to_jsonb(v_result);
end;
$$;

comment on function public.finalise_audio_upload(uuid) is
  'Atomically acknowledges immutable audio metadata only after the exact reserved object exists in private Storage.';

-- Storage bytes can only be inserted while an unexpired exact-size reservation
-- exists. Object metadata is read-only application data populated by Storage.
drop policy if exists "owners can upload immutable story audio" on storage.objects;
create policy "owners can upload reserved immutable story audio"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'story-audio'
  and exists (
    select 1
    from public.audio_upload_reservations reservation
    where reservation.owner_id = (select auth.uid())
      and reservation.storage_object_name = name
      and reservation.finalised_at is null
      and reservation.expires_at > clock_timestamp()
      and reservation.byte_size = case
        when coalesce(metadata->>'size', '') ~ '^[0-9]+$'
          then (metadata->>'size')::bigint
        else -1
      end
  )
);

-- A spoken segment is one user action, but its recording is persisted as
-- ordered standalone media containers. Replace the temporary single-object
-- reservation shape above before this migration commits.
drop policy "owners can upload reserved immutable story audio" on storage.objects;
drop function public.finalise_audio_upload(uuid);
drop function public.reserve_audio_upload(uuid, uuid, integer, text, bigint, integer, timestamptz, text);
drop function private.audio_storage_bytes_for_owner(uuid);
drop table public.audio_upload_reservations;

alter table public.audio_segments
  drop constraint audio_segments_storage_object_unique,
  drop constraint audio_segments_media_type_audio,
  drop constraint audio_segments_byte_size_positive,
  drop constraint audio_segments_sha256_format,
  drop constraint audio_segments_storage_path_matches_row,
  drop column storage_object_name,
  drop column media_type,
  drop column byte_size,
  drop column audio_sha256;

create table public.audio_segment_parts (
  id uuid primary key,
  audio_segment_id uuid not null,
  story_id uuid not null,
  owner_id uuid not null,
  part_number integer not null,
  storage_object_name text not null,
  media_type text not null,
  byte_size bigint not null,
  duration_ms integer not null,
  audio_sha256 text not null,
  start_offset_ms integer not null,
  created_at timestamptz not null default now(),
  constraint audio_segment_parts_segment_owner_fk
    foreign key (audio_segment_id, story_id, owner_id)
    references public.audio_segments (id, story_id, owner_id)
    on delete cascade,
  constraint audio_segment_parts_segment_number_unique
    unique (audio_segment_id, part_number),
  constraint audio_segment_parts_storage_object_unique
    unique (storage_object_name),
  constraint audio_segment_parts_part_number_positive check (part_number >= 1),
  constraint audio_segment_parts_media_type_audio check (
    char_length(media_type) between 7 and 255
    and lower(media_type) like 'audio/%'
  ),
  constraint audio_segment_parts_byte_size_limit check (
    byte_size between 1 and 20000000
  ),
  constraint audio_segment_parts_duration_limit check (
    duration_ms between 1 and 240000
  ),
  constraint audio_segment_parts_start_offset_limit check (
    start_offset_ms between 0 and 1800000
  ),
  constraint audio_segment_parts_sha256_format check (
    audio_sha256 ~ '^[0-9A-Fa-f]{64}$'
  ),
  constraint audio_segment_parts_storage_path_matches_row check (
    split_part(storage_object_name, '/', 1) = owner_id::text
    and split_part(storage_object_name, '/', 2) = story_id::text
    and split_part(storage_object_name, '/', 3) = audio_segment_id::text
    and split_part(storage_object_name, '/', 5) = ''
    and split_part(split_part(storage_object_name, '/', 4), '.', 1) = part_number::text
    and char_length(split_part(split_part(storage_object_name, '/', 4), '.', 2)) between 1 and 10
    and split_part(split_part(storage_object_name, '/', 4), '.', 3) = ''
  )
);

comment on table public.audio_segment_parts is
  'Ordered immutable standalone media containers belonging to one explicit start-to-stop recording.';

create index audio_segment_parts_story_segment_idx
  on public.audio_segment_parts (story_id, audio_segment_id, part_number);
create index audio_segment_parts_owner_created_idx
  on public.audio_segment_parts (owner_id, created_at);

create trigger audio_segment_parts_reject_update
before update on public.audio_segment_parts
for each row execute function private.reject_immutable_update();

alter table public.audio_segment_parts enable row level security;
create policy "owners can read their audio parts"
on public.audio_segment_parts for select
to authenticated
using ((select auth.uid()) = owner_id);

revoke all on table public.audio_segment_parts from anon, authenticated;
grant select on table public.audio_segment_parts to authenticated;
grant select, insert, delete on table public.audio_segment_parts to service_role;

create table public.audio_upload_reservations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  story_id uuid not null,
  client_segment_id uuid not null,
  sequence_number integer not null,
  duration_ms integer not null,
  recorded_at timestamptz not null,
  part_count integer not null,
  total_byte_size bigint not null,
  expires_at timestamptz not null,
  finalised_at timestamptz,
  created_at timestamptz not null default now(),
  constraint audio_upload_reservations_story_owner_fk
    foreign key (story_id, owner_id)
    references public.stories (id, owner_id)
    on delete cascade,
  constraint audio_upload_reservations_owner_client_unique
    unique (owner_id, client_segment_id),
  constraint audio_upload_reservations_id_scope_unique
    unique (id, owner_id, story_id, client_segment_id),
  constraint audio_upload_reservations_sequence_positive check (
    sequence_number >= 1
  ),
  constraint audio_upload_reservations_duration_limit check (
    duration_ms between 1 and 1800000
  ),
  constraint audio_upload_reservations_part_count_range check (
    part_count between 1 and 16
  ),
  constraint audio_upload_reservations_total_bytes_positive check (
    total_byte_size > 0
  ),
  constraint audio_upload_reservations_expiry_after_creation check (
    expires_at > created_at
  ),
  constraint audio_upload_reservations_finalised_after_creation check (
    finalised_at is null or finalised_at >= created_at
  )
);

create table public.audio_upload_part_reservations (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null,
  owner_id uuid not null,
  story_id uuid not null,
  client_segment_id uuid not null,
  part_number integer not null,
  storage_object_name text not null,
  media_type text not null,
  byte_size bigint not null,
  duration_ms integer not null,
  audio_sha256 text not null,
  start_offset_ms integer not null,
  created_at timestamptz not null default now(),
  constraint audio_upload_part_reservations_batch_fk
    foreign key (reservation_id, owner_id, story_id, client_segment_id)
    references public.audio_upload_reservations (id, owner_id, story_id, client_segment_id)
    on delete cascade,
  constraint audio_upload_part_reservations_batch_number_unique
    unique (reservation_id, part_number),
  constraint audio_upload_part_reservations_storage_object_unique
    unique (storage_object_name),
  constraint audio_upload_part_reservations_part_number_positive check (
    part_number >= 1
  ),
  constraint audio_upload_part_reservations_media_type_audio check (
    char_length(media_type) between 7 and 255
    and lower(media_type) like 'audio/%'
  ),
  constraint audio_upload_part_reservations_byte_size_limit check (
    byte_size between 1 and 20000000
  ),
  constraint audio_upload_part_reservations_duration_limit check (
    duration_ms between 1 and 240000
  ),
  constraint audio_upload_part_reservations_start_offset_limit check (
    start_offset_ms between 0 and 1800000
  ),
  constraint audio_upload_part_reservations_sha256_format check (
    audio_sha256 ~ '^[0-9A-Fa-f]{64}$'
  ),
  constraint audio_upload_part_reservations_storage_path_matches_row check (
    split_part(storage_object_name, '/', 1) = owner_id::text
    and split_part(storage_object_name, '/', 2) = story_id::text
    and split_part(storage_object_name, '/', 3) = client_segment_id::text
    and split_part(storage_object_name, '/', 5) = ''
    and split_part(split_part(storage_object_name, '/', 4), '.', 1) = part_number::text
    and char_length(split_part(split_part(storage_object_name, '/', 4), '.', 2)) between 1 and 10
    and split_part(split_part(storage_object_name, '/', 4), '.', 3) = ''
  )
);

comment on table public.audio_upload_reservations is
  'Short-lived quota authority for every standalone part of one logical audio segment.';
comment on table public.audio_upload_part_reservations is
  'Exact-size, immutable object authorities belonging to one segment reservation.';

create index audio_upload_reservations_owner_expiry_idx
  on public.audio_upload_reservations (owner_id, expires_at)
  where finalised_at is null;
create index audio_upload_reservations_story_sequence_idx
  on public.audio_upload_reservations (story_id, sequence_number);
create index audio_upload_part_reservations_owner_batch_idx
  on public.audio_upload_part_reservations (owner_id, reservation_id, part_number);

alter table public.audio_upload_reservations enable row level security;
alter table public.audio_upload_part_reservations enable row level security;
create policy "owners can read their audio upload reservations"
on public.audio_upload_reservations for select
to authenticated
using ((select auth.uid()) = owner_id);
create policy "owners can read their audio part reservations"
on public.audio_upload_part_reservations for select
to authenticated
using ((select auth.uid()) = owner_id);

revoke all on table public.audio_upload_reservations from anon, authenticated;
revoke all on table public.audio_upload_part_reservations from anon, authenticated;
grant select on table public.audio_upload_reservations to authenticated;
grant select on table public.audio_upload_part_reservations to authenticated;
grant select, insert, update, delete on table public.audio_upload_reservations
  to service_role;
grant select, insert, delete on table public.audio_upload_part_reservations
  to service_role;

create function private.audio_storage_bytes_for_owner(p_owner_id uuid)
returns bigint
language sql
security invoker
stable
set search_path = ''
as $$
  select
    coalesce((
      select sum(
        case
          when coalesce(object.metadata->>'size', '') ~ '^[0-9]+$'
            then (object.metadata->>'size')::bigint
          else 0
        end
      )
      from storage.objects object
      where object.bucket_id = 'story-audio'
        and split_part(object.name, '/', 1) = p_owner_id::text
    ), 0)::bigint
    +
    coalesce((
      select sum(part.byte_size)
      from public.audio_upload_part_reservations part
      join public.audio_upload_reservations reservation
        on reservation.id = part.reservation_id
      where reservation.owner_id = p_owner_id
        and reservation.finalised_at is null
        and reservation.expires_at > clock_timestamp()
        and not exists (
          select 1
          from storage.objects object
          where object.bucket_id = 'story-audio'
            and object.name = part.storage_object_name
        )
    ), 0)::bigint;
$$;

revoke all on function private.audio_storage_bytes_for_owner(uuid)
  from public, anon, authenticated;

create function private.audio_upload_reservation_payload(p_reservation_id uuid)
returns jsonb
language sql
security invoker
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'reservation', to_jsonb(reservation),
    'parts', coalesce((
      select jsonb_agg(to_jsonb(part) order by part.part_number)
      from public.audio_upload_part_reservations part
      where part.reservation_id = reservation.id
    ), '[]'::jsonb)
  )
  from public.audio_upload_reservations reservation
  where reservation.id = p_reservation_id;
$$;

revoke all on function private.audio_upload_reservation_payload(uuid)
  from public, anon, authenticated;

create function public.reserve_audio_upload(
  p_story_id uuid,
  p_client_segment_id uuid,
  p_preferred_sequence_number integer,
  p_duration_ms integer,
  p_recorded_at timestamptz,
  p_parts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid := (select auth.uid());
  v_quota_bytes bigint;
  v_reservation_ttl interval;
  v_used_bytes bigint;
  v_total_bytes bigint := 0;
  v_missing_bytes bigint;
  v_part_count integer;
  v_sequence_number integer;
  v_extension text;
  v_media_type text;
  v_part jsonb;
  v_part_number integer;
  v_part_byte_size bigint;
  v_part_duration_ms integer;
  v_part_start_offset_ms integer;
  v_part_sha256 text;
  v_storage_object_name text;
  v_existing public.audio_upload_reservations%rowtype;
  v_result public.audio_upload_reservations%rowtype;
begin
  if v_owner_id is null then
    raise exception using errcode = '42501', message = 'authentication is required';
  end if;
  if p_story_id is null
    or p_client_segment_id is null
    or p_preferred_sequence_number is null
    or p_preferred_sequence_number < 1
    or p_duration_ms not between 1 and 1800000
    or p_recorded_at is null
    or jsonb_typeof(p_parts) <> 'array'
    or jsonb_array_length(p_parts) not between 1 and 16
  then
    raise exception using errcode = '22023', message = 'invalid audio reservation input';
  end if;

  v_part_count := jsonb_array_length(p_parts);
  for v_part in select value from jsonb_array_elements(p_parts)
  loop
    if jsonb_typeof(v_part) <> 'object' then
      raise exception using errcode = '22023', message = 'invalid audio part input';
    end if;
    begin
      v_part_number := (v_part->>'part_number')::integer;
      v_part_byte_size := (v_part->>'byte_size')::bigint;
      v_part_duration_ms := (v_part->>'duration_ms')::integer;
      v_part_start_offset_ms := (v_part->>'start_offset_ms')::integer;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid audio part input';
    end;
    v_media_type := lower(btrim(v_part->>'media_type'));
    v_part_sha256 := nullif(lower(v_part->>'audio_sha256'), '');
    if v_part_number not between 1 and v_part_count
      or v_part_byte_size not between 1 and 20000000
      or v_part_duration_ms not between 1 and 240000
      or v_part_start_offset_ms not between 0 and 1800000
      or char_length(v_media_type) not between 7 and 255
      or v_media_type not like 'audio/%'
      or v_part_sha256 is null
      or v_part_sha256 !~ '^[0-9a-f]{64}$'
    then
      raise exception using errcode = '22023', message = 'invalid audio part input';
    end if;
    v_extension := case split_part(v_media_type, ';', 1)
      when 'audio/webm' then 'webm'
      when 'audio/mp4' then 'm4a'
      when 'audio/ogg' then 'ogg'
      when 'audio/mpeg' then 'mp3'
      when 'audio/wav' then 'wav'
      when 'audio/x-wav' then 'wav'
      else null
    end;
    if v_extension is null then
      raise exception using errcode = '22023', message = 'unsupported audio media type';
    end if;
    v_total_bytes := v_total_bytes + v_part_byte_size;
  end loop;

  if (
    select count(distinct (part->>'part_number')::integer) <> v_part_count
      or min((part->>'part_number')::integer) <> 1
      or max((part->>'part_number')::integer) <> v_part_count
    from jsonb_array_elements(p_parts) part
  ) then
    raise exception using errcode = '22023', message = 'audio parts must be uniquely and contiguously ordered';
  end if;

  if (
    select coalesce(sum((part->>'duration_ms')::bigint), 0) <> p_duration_ms
    from jsonb_array_elements(p_parts) part
  ) or exists (
    select 1
    from (
      select
        (part->>'start_offset_ms')::bigint as submitted_start_offset_ms,
        coalesce(
          sum((part->>'duration_ms')::bigint) over (
            order by (part->>'part_number')::integer
            rows between unbounded preceding and 1 preceding
          ),
          0
        ) as expected_start_offset_ms
      from jsonb_array_elements(p_parts) part
    ) timing
    where timing.submitted_start_offset_ms <> timing.expected_start_offset_ms
  ) then
    raise exception using
      errcode = '22023',
      message = 'audio part timing must be contiguous and equal the logical duration';
  end if;

  if not exists (
    select 1 from public.stories story
    where story.id = p_story_id and story.owner_id = v_owner_id
  ) then
    raise exception using errcode = '42501', message = 'story is unavailable';
  end if;

  insert into private.audio_storage_accounts (owner_id)
  values (v_owner_id)
  on conflict (owner_id) do nothing;
  perform 1 from private.audio_storage_accounts account
  where account.owner_id = v_owner_id
  for update;

  select policy.per_account_quota_bytes, policy.upload_reservation_ttl
    into v_quota_bytes, v_reservation_ttl
  from private.audio_storage_policy policy
  where policy.singleton;
  if not found then
    raise exception using errcode = 'LEQ01', message = 'audio storage quota is not configured';
  end if;

  if exists (
    select 1 from storage.objects object
    where object.bucket_id = 'story-audio'
      and split_part(object.name, '/', 1) = v_owner_id::text
      and coalesce(object.metadata->>'size', '') !~ '^[0-9]+$'
  ) then
    raise exception using errcode = 'LEQ03', message = 'stored audio size is unavailable';
  end if;

  select reservation.* into v_existing
  from public.audio_upload_reservations reservation
  where reservation.owner_id = v_owner_id
    and reservation.client_segment_id = p_client_segment_id
  for update;

  if found then
    if v_existing.story_id <> p_story_id
      or v_existing.duration_ms <> p_duration_ms
      or v_existing.recorded_at <> p_recorded_at
      or v_existing.part_count <> v_part_count
      or v_existing.total_byte_size <> v_total_bytes
      or exists (
        select 1
        from jsonb_array_elements(p_parts) submitted
        where not exists (
          select 1
          from public.audio_upload_part_reservations stored
          where stored.reservation_id = v_existing.id
            and stored.part_number = (submitted->>'part_number')::integer
            and stored.media_type = lower(btrim(submitted->>'media_type'))
            and stored.byte_size = (submitted->>'byte_size')::bigint
            and stored.duration_ms = (submitted->>'duration_ms')::integer
            and stored.start_offset_ms = (submitted->>'start_offset_ms')::integer
            and stored.audio_sha256 is not distinct from nullif(lower(submitted->>'audio_sha256'), '')
        )
      )
    then
      raise exception using errcode = '22000', message = 'audio reservation conflicts with an earlier request';
    end if;

    if v_existing.finalised_at is not null or v_existing.expires_at > clock_timestamp() then
      return private.audio_upload_reservation_payload(v_existing.id);
    end if;

    select coalesce(sum(part.byte_size), 0) into v_missing_bytes
    from public.audio_upload_part_reservations part
    where part.reservation_id = v_existing.id
      and not exists (
        select 1 from storage.objects object
        where object.bucket_id = 'story-audio'
          and object.name = part.storage_object_name
      );
    v_used_bytes := private.audio_storage_bytes_for_owner(v_owner_id);
    if v_used_bytes + v_missing_bytes > v_quota_bytes then
      raise exception using errcode = 'LEQ02', message = 'audio storage quota would be exceeded';
    end if;
    update public.audio_upload_reservations reservation
    set expires_at = clock_timestamp() + v_reservation_ttl
    where reservation.id = v_existing.id
    returning reservation.* into v_result;
    return private.audio_upload_reservation_payload(v_result.id);
  end if;

  v_used_bytes := private.audio_storage_bytes_for_owner(v_owner_id);
  if v_used_bytes + v_total_bytes > v_quota_bytes then
    raise exception using errcode = 'LEQ02', message = 'audio storage quota would be exceeded';
  end if;

  v_sequence_number := p_preferred_sequence_number;
  if exists (
    select 1 from public.audio_segments segment
    where segment.story_id = p_story_id and segment.sequence_number = v_sequence_number
  ) or exists (
    select 1 from public.audio_upload_reservations reservation
    where reservation.story_id = p_story_id and reservation.sequence_number = v_sequence_number
  ) then
    select coalesce(max(candidate.sequence_number), 0) + 1 into v_sequence_number
    from (
      select segment.sequence_number from public.audio_segments segment
      where segment.story_id = p_story_id
      union all
      select reservation.sequence_number from public.audio_upload_reservations reservation
      where reservation.story_id = p_story_id
    ) candidate;
  end if;

  insert into public.audio_upload_reservations (
    owner_id, story_id, client_segment_id, sequence_number, duration_ms,
    recorded_at, part_count, total_byte_size, expires_at
  ) values (
    v_owner_id, p_story_id, p_client_segment_id, v_sequence_number, p_duration_ms,
    p_recorded_at, v_part_count, v_total_bytes, clock_timestamp() + v_reservation_ttl
  ) returning * into v_result;

  for v_part in select value from jsonb_array_elements(p_parts)
  loop
    v_part_number := (v_part->>'part_number')::integer;
    v_media_type := lower(btrim(v_part->>'media_type'));
    v_part_byte_size := (v_part->>'byte_size')::bigint;
    v_part_duration_ms := (v_part->>'duration_ms')::integer;
    v_part_start_offset_ms := (v_part->>'start_offset_ms')::integer;
    v_part_sha256 := nullif(lower(v_part->>'audio_sha256'), '');
    v_extension := case split_part(v_media_type, ';', 1)
      when 'audio/webm' then 'webm' when 'audio/mp4' then 'm4a'
      when 'audio/ogg' then 'ogg' when 'audio/mpeg' then 'mp3'
      when 'audio/wav' then 'wav' when 'audio/x-wav' then 'wav'
    end;
    v_storage_object_name := v_owner_id::text || '/' || p_story_id::text || '/' ||
      p_client_segment_id::text || '/' || v_part_number::text || '.' || v_extension;
    insert into public.audio_upload_part_reservations (
      reservation_id, owner_id, story_id, client_segment_id, part_number,
      storage_object_name, media_type, byte_size, duration_ms, audio_sha256, start_offset_ms
    ) values (
      v_result.id, v_owner_id, p_story_id, p_client_segment_id,
      v_part_number, v_storage_object_name, v_media_type, v_part_byte_size,
      v_part_duration_ms, v_part_sha256, v_part_start_offset_ms
    );
  end loop;

  return private.audio_upload_reservation_payload(v_result.id);
end;
$$;

comment on function public.reserve_audio_upload(uuid, uuid, integer, integer, timestamptz, jsonb) is
  'Atomically reserves account quota and exact object paths for every ordered standalone part of one logical segment.';

create function public.finalise_audio_upload(p_client_segment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid := (select auth.uid());
  v_reservation public.audio_upload_reservations%rowtype;
  v_existing public.audio_segments%rowtype;
  v_result public.audio_segments%rowtype;
begin
  if v_owner_id is null then
    raise exception using errcode = '42501', message = 'authentication is required';
  end if;
  select reservation.* into v_reservation
  from public.audio_upload_reservations reservation
  where reservation.owner_id = v_owner_id
    and reservation.client_segment_id = p_client_segment_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'audio reservation was not found';
  end if;

  if (select count(*) from public.audio_upload_part_reservations part where part.reservation_id = v_reservation.id) <> v_reservation.part_count
    or (select coalesce(sum(part.duration_ms), 0) from public.audio_upload_part_reservations part where part.reservation_id = v_reservation.id) <> v_reservation.duration_ms
    or exists (
      select 1
      from (
        select
          part.start_offset_ms as submitted_start_offset_ms,
          coalesce(
            sum(part.duration_ms) over (
              order by part.part_number
              rows between unbounded preceding and 1 preceding
            ),
            0
          ) as expected_start_offset_ms
        from public.audio_upload_part_reservations part
        where part.reservation_id = v_reservation.id
      ) timing
      where timing.submitted_start_offset_ms <> timing.expected_start_offset_ms
    )
  then
    raise exception using
      errcode = '22000',
      message = 'audio part timing conflicts with its logical segment';
  end if;

  if exists (
    select 1
    from public.audio_upload_part_reservations part
    left join storage.objects object
      on object.bucket_id = 'story-audio' and object.name = part.storage_object_name
    where part.reservation_id = v_reservation.id
      and (
        object.id is null
        or coalesce(object.metadata->>'size', '') !~ '^[0-9]+$'
        or (object.metadata->>'size')::bigint <> part.byte_size
        or lower(coalesce(object.user_metadata->>'audio_sha256', '')) <> part.audio_sha256
        or coalesce(object.user_metadata->>'audio_part_id', '') <> part.id::text
        or coalesce(object.user_metadata->>'client_segment_id', '') <> part.client_segment_id::text
        or coalesce(object.user_metadata->>'part_number', '') <> part.part_number::text
      )
  ) then
    raise exception using errcode = 'LEQ03', message = 'uploaded audio parts do not match their reservation';
  end if;

  select segment.* into v_existing
  from public.audio_segments segment
  where segment.owner_id = v_owner_id
    and segment.client_segment_id = p_client_segment_id;
  if found then
    if v_existing.story_id <> v_reservation.story_id
      or v_existing.sequence_number <> v_reservation.sequence_number
      or v_existing.duration_ms <> v_reservation.duration_ms
      or v_existing.recorded_at <> v_reservation.recorded_at
      or (select count(*) from public.audio_segment_parts part where part.audio_segment_id = v_existing.id) <> v_reservation.part_count
    then
      raise exception using errcode = '22000', message = 'finalised audio conflicts with its reservation';
    end if;
    return jsonb_build_object(
      'segment', to_jsonb(v_existing),
      'parts', (select jsonb_agg(to_jsonb(part) order by part.part_number)
                from public.audio_segment_parts part
                where part.audio_segment_id = v_existing.id)
    );
  end if;

  insert into public.audio_segments (
    id, story_id, owner_id, client_segment_id, sequence_number, duration_ms, recorded_at
  ) values (
    v_reservation.client_segment_id, v_reservation.story_id, v_reservation.owner_id,
    v_reservation.client_segment_id, v_reservation.sequence_number,
    v_reservation.duration_ms, v_reservation.recorded_at
  ) returning * into v_result;

  insert into public.audio_segment_parts (
    id, audio_segment_id, story_id, owner_id, part_number, storage_object_name,
    media_type, byte_size, duration_ms, audio_sha256, start_offset_ms
  )
  select part.id, v_result.id, part.story_id, part.owner_id, part.part_number,
    part.storage_object_name, part.media_type, part.byte_size, part.duration_ms,
    part.audio_sha256, part.start_offset_ms
  from public.audio_upload_part_reservations part
  where part.reservation_id = v_reservation.id
  order by part.part_number;

  update public.audio_upload_reservations reservation
  set finalised_at = clock_timestamp()
  where reservation.id = v_reservation.id;

  return jsonb_build_object(
    'segment', to_jsonb(v_result),
    'parts', (select jsonb_agg(to_jsonb(part) order by part.part_number)
              from public.audio_segment_parts part
              where part.audio_segment_id = v_result.id)
  );
end;
$$;

comment on function public.finalise_audio_upload(uuid) is
  'Atomically creates one logical segment and its ordered immutable parts only after every exact reserved object exists.';

create policy "owners can upload reserved immutable story audio parts"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'story-audio'
  and exists (
    select 1
    from public.audio_upload_part_reservations part
    join public.audio_upload_reservations reservation
      on reservation.id = part.reservation_id
    where reservation.owner_id = (select auth.uid())
      and part.storage_object_name = name
      and reservation.finalised_at is null
      and reservation.expires_at > clock_timestamp()
      and part.byte_size = case
        when coalesce(metadata->>'size', '') ~ '^[0-9]+$'
          then (metadata->>'size')::bigint
        else -1
      end
      and lower(coalesce(user_metadata->>'audio_sha256', '')) = part.audio_sha256
      and coalesce(user_metadata->>'audio_part_id', '') = part.id::text
      and coalesce(user_metadata->>'client_segment_id', '') = part.client_segment_id::text
      and coalesce(user_metadata->>'part_number', '') = part.part_number::text
  )
);

create function public.append_story_version(
  p_client_version_id uuid,
  p_story_id uuid,
  p_story_text text,
  p_reason text,
  p_restored_from_version_id uuid default null,
  p_content_sha256 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid := (select auth.uid());
  v_existing public.story_versions%rowtype;
  v_result public.story_versions%rowtype;
  v_version_number bigint;
begin
  if v_owner_id is null then
    raise exception using errcode = '42501', message = 'authentication is required';
  end if;
  if p_client_version_id is null
    or p_story_id is null
    or p_story_text is null
    or p_reason !~ '^[a-z][a-z0-9-]{0,31}$'
    or (p_content_sha256 is not null and p_content_sha256 !~ '^[0-9A-Fa-f]{64}$')
  then
    raise exception using errcode = '22023', message = 'invalid story version input';
  end if;

  perform 1
  from public.stories story
  where story.id = p_story_id
    and story.owner_id = v_owner_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'story is unavailable';
  end if;

  select version.*
    into v_existing
  from public.story_versions version
  where version.id = p_client_version_id;
  if found then
    if v_existing.story_id <> p_story_id
      or v_existing.owner_id <> v_owner_id
      or v_existing.story_text <> p_story_text
      or v_existing.reason <> p_reason
      or v_existing.restored_from_version_id is distinct from p_restored_from_version_id
      or v_existing.content_sha256 is distinct from lower(p_content_sha256)
    then
      raise exception using errcode = '22000', message = 'story version conflicts with an earlier request';
    end if;
    return to_jsonb(v_existing);
  end if;

  if p_restored_from_version_id is not null and not exists (
    select 1
    from public.story_versions restored
    where restored.id = p_restored_from_version_id
      and restored.story_id = p_story_id
      and restored.owner_id = v_owner_id
  ) then
    raise exception using errcode = '22023', message = 'restored version is unavailable';
  end if;

  select coalesce(max(version.version_number), 0) + 1
    into v_version_number
  from public.story_versions version
  where version.story_id = p_story_id;

  insert into public.story_versions (
    id,
    story_id,
    owner_id,
    version_number,
    story_text,
    reason,
    restored_from_version_id,
    content_sha256
  )
  values (
    p_client_version_id,
    p_story_id,
    v_owner_id,
    v_version_number,
    p_story_text,
    p_reason,
    p_restored_from_version_id,
    lower(p_content_sha256)
  )
  returning * into v_result;

  return to_jsonb(v_result);
end;
$$;

comment on function public.append_story_version(uuid, uuid, text, text, uuid, text) is
  'Serialises server-side version allocation so concurrent editors retain distinct immutable candidates.';

create table public.story_edit_conflicts (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null,
  owner_id uuid not null,
  expected_revision bigint not null,
  observed_revision bigint not null,
  incumbent_version_id uuid,
  candidate_version_id uuid not null,
  candidate_title text,
  title_was_updated boolean not null default false,
  created_at timestamptz not null default now(),
  constraint story_edit_conflicts_story_owner_fk
    foreign key (story_id, owner_id)
    references public.stories (id, owner_id)
    on delete cascade,
  constraint story_edit_conflicts_incumbent_same_story_fk
    foreign key (incumbent_version_id, story_id, owner_id)
    references public.story_versions (id, story_id, owner_id)
    on delete restrict,
  constraint story_edit_conflicts_candidate_same_story_fk
    foreign key (candidate_version_id, story_id, owner_id)
    references public.story_versions (id, story_id, owner_id)
    on delete restrict,
  constraint story_edit_conflicts_revisions_nonnegative check (
    expected_revision >= 0 and observed_revision >= 0
  ),
  constraint story_edit_conflicts_title_length check (
    candidate_title is null or char_length(btrim(candidate_title)) between 1 and 160
  ),
  constraint story_edit_conflicts_candidate_observation_unique
    unique (story_id, candidate_version_id, observed_revision)
);

comment on table public.story_edit_conflicts is
  'Immutable evidence that a preserved candidate was not promoted because another editor had already changed the story.';

create index story_edit_conflicts_owner_created_idx
  on public.story_edit_conflicts (owner_id, created_at desc);
create index story_edit_conflicts_story_created_idx
  on public.story_edit_conflicts (story_id, created_at desc);

alter table public.story_edit_conflicts enable row level security;
create policy "owners can read their story edit conflicts"
on public.story_edit_conflicts for select
to authenticated
using ((select auth.uid()) = owner_id);

revoke all on table public.story_edit_conflicts from anon, authenticated;
grant select on table public.story_edit_conflicts to authenticated;
grant select, insert, delete on table public.story_edit_conflicts to service_role;

create trigger story_edit_conflicts_reject_update
before update on public.story_edit_conflicts
for each row execute function private.reject_immutable_update();

create function public.commit_story_edit(
  p_story_id uuid,
  p_current_text text,
  p_expected_revision bigint,
  p_candidate_version_id uuid,
  p_update_title boolean default false,
  p_title text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid := (select auth.uid());
  v_story public.stories%rowtype;
  v_conflict public.story_edit_conflicts%rowtype;
  v_normalised_title text;
begin
  if v_owner_id is null then
    raise exception using errcode = '42501', message = 'authentication is required';
  end if;
  if p_story_id is null
    or p_current_text is null
    or p_expected_revision is null
    or p_expected_revision < 0
    or p_candidate_version_id is null
  then
    raise exception using errcode = '22023', message = 'invalid story edit input';
  end if;

  if p_update_title then
    if p_title is not null and char_length(btrim(p_title)) not between 1 and 160 then
      raise exception using errcode = '22023', message = 'invalid story title';
    end if;
    v_normalised_title := case when p_title is null then null else btrim(p_title) end;
  end if;

  select story.*
    into v_story
  from public.stories story
  where story.id = p_story_id
    and story.owner_id = v_owner_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'story is unavailable';
  end if;

  if not exists (
    select 1
    from public.story_versions candidate
    where candidate.id = p_candidate_version_id
      and candidate.story_id = p_story_id
      and candidate.owner_id = v_owner_id
      and candidate.story_text = p_current_text
  ) then
    raise exception using
      errcode = '22023',
      message = 'candidate version must preserve the submitted story text';
  end if;

  if v_story.current_version_id = p_candidate_version_id
    and v_story.current_text = p_current_text
    and (
      not p_update_title
      or v_story.title is not distinct from v_normalised_title
    )
  then
    return jsonb_build_object(
      'outcome', 'already-applied',
      'conflict_id', null,
      'conflict', null,
      'story', to_jsonb(v_story)
    );
  end if;

  if v_story.revision <> p_expected_revision then
    insert into public.story_edit_conflicts (
      story_id,
      owner_id,
      expected_revision,
      observed_revision,
      incumbent_version_id,
      candidate_version_id,
      candidate_title,
      title_was_updated
    )
    values (
      p_story_id,
      v_owner_id,
      p_expected_revision,
      v_story.revision,
      v_story.current_version_id,
      p_candidate_version_id,
      case when p_update_title then v_normalised_title else null end,
      p_update_title
    )
    on conflict (story_id, candidate_version_id, observed_revision) do nothing
    returning * into v_conflict;

    if v_conflict.id is null then
      select conflict.*
        into strict v_conflict
      from public.story_edit_conflicts conflict
      where conflict.story_id = p_story_id
        and conflict.candidate_version_id = p_candidate_version_id
        and conflict.observed_revision = v_story.revision;
    end if;

    return jsonb_build_object(
      'outcome', 'conflict',
      'conflict_id', v_conflict.id,
      'conflict', to_jsonb(v_conflict),
      'story', to_jsonb(v_story)
    );
  end if;

  update public.stories story
  set current_text = p_current_text,
      current_version_id = p_candidate_version_id,
      title = case when p_update_title then v_normalised_title else story.title end
  where story.id = p_story_id
    and story.owner_id = v_owner_id
    and story.revision = p_expected_revision
  returning story.* into v_story;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'story revision changed during the locked update';
  end if;

  return jsonb_build_object(
    'outcome', 'updated',
    'conflict_id', null,
    'conflict', null,
    'story', to_jsonb(v_story)
  );
end;
$$;

comment on function public.commit_story_edit(uuid, text, bigint, uuid, boolean, text) is
  'Promotes one preserved version only at the expected revision; stale candidates remain immutable and receive a visible conflict record.';

-- These writes must now go through the narrow RPCs above. Guest migration is
-- made SECURITY DEFINER because it still needs to create the initial rows after
-- direct authenticated version/update privileges are removed; its auth.uid()
-- ownership checks remain in force.
alter function public.migrate_guest_story(uuid, uuid, text, timestamptz, boolean, text, text)
  security definer;

drop policy if exists "owners can edit their stories" on public.stories;
drop policy if exists "owners can create their stories" on public.stories;
drop policy if exists "owners can append their audio metadata" on public.audio_segments;
drop policy if exists "owners can append their story versions" on public.story_versions;
drop policy if exists "owners can append their migration receipts" on public.migration_receipts;

revoke insert (owner_id, client_story_id, title, current_text, captured_at)
  on table public.stories from authenticated;
revoke update (title, current_text, current_version_id)
  on table public.stories from authenticated;
revoke insert (
  id,
  story_id,
  owner_id,
  client_segment_id,
  sequence_number,
  duration_ms,
  recorded_at
) on table public.audio_segments from authenticated;
revoke insert (
  id,
  story_id,
  owner_id,
  version_number,
  story_text,
  reason,
  restored_from_version_id,
  content_sha256
) on table public.story_versions from authenticated;
revoke insert (owner_id, idempotency_key, guest_draft_id, story_id, payload_sha256)
  on table public.migration_receipts from authenticated;

revoke all on function public.reserve_audio_upload(uuid, uuid, integer, integer, timestamptz, jsonb)
  from public, anon;
revoke all on function public.finalise_audio_upload(uuid)
  from public, anon;
revoke all on function public.append_story_version(uuid, uuid, text, text, uuid, text)
  from public, anon;
revoke all on function public.commit_story_edit(uuid, text, bigint, uuid, boolean, text)
  from public, anon;

grant execute on function public.reserve_audio_upload(uuid, uuid, integer, integer, timestamptz, jsonb)
  to authenticated;
grant execute on function public.finalise_audio_upload(uuid)
  to authenticated;
grant execute on function public.append_story_version(uuid, uuid, text, text, uuid, text)
  to authenticated;
grant execute on function public.commit_story_edit(uuid, text, bigint, uuid, boolean, text)
  to authenticated;

commit;
