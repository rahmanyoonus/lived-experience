-- Storage creates the object row before all system and custom metadata is
-- available to RLS. Authorise only the exact unexpired reservation path here;
-- finalise_audio_upload remains the authority for byte size, SHA-256 and part
-- metadata before any cloud-save acknowledgement is possible.
drop policy if exists "owners can upload reserved immutable story audio"
  on storage.objects;

create policy "owners can upload reserved immutable story audio"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'story-audio'
  and owner_id = (select auth.uid())::text
  and exists (
    select 1
    from public.audio_upload_part_reservations part
    join public.audio_upload_reservations reservation
      on reservation.id = part.reservation_id
    where reservation.owner_id = (select auth.uid())
      and part.storage_object_name = name
      and reservation.finalised_at is null
      and reservation.expires_at > clock_timestamp()
  )
);
