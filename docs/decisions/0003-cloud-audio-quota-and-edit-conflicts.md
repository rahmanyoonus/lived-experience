# ADR 0003: Cloud audio quota and edit conflicts

- **Status:** Accepted
- **Date:** 19 July 2026
- **Decision owners:** Product owner and implementation team

## Context

The first authenticated slice uses a Supabase Free project, whose stated file
storage allowance is 1 GB for the whole project. Original recordings are
sensitive, immutable source artefacts. An upload must therefore be rejected
before it can create unbounded or orphaned storage, and one account must not be
able to consume the full project allowance.

The same story can also be open in more than one browser or tab. Automatically
merging personal story text could change meaning, while last-write-wins would
silently discard one person's acknowledged work.

## Decision

Set the authenticated audio allowance to **750,000,000 bytes per account** for
this version. Keep the remaining 250 MB of the stated project allowance as
shared operational headroom rather than presenting it as user capacity.

Cloud audio uses two immutable layers:

- one logical audio segment for each explicit user start-to-stop action; and
- ordered, independently playable audio parts beneath that segment.

Before any Storage upload, the client must obtain an owner-bound reservation
for the exact object path and byte count. Quota calculation includes committed
private audio and all live reservations. Reservations are serialised per owner,
expire if abandoned, are safe to retry, and fail closed when the deployment
quota is unavailable. Storage policy accepts only an exact, unexpired
reservation. Database metadata is finalised only after the matching private
object exists.

For concurrent story edits, preserve both candidates and never auto-merge:

1. preserve the proposed local text as an immutable story version;
2. promote it only when the story revision still matches the revision the
   editor observed;
3. if another edit won first, keep the incumbent current story unchanged,
   retain the proposed version, and create an immutable conflict record; and
4. show the conflict in the application so the person can review the preserved
   versions and deliberately choose what becomes current.

The interface must not show **Saved** for a conflicted local current view merely
because its candidate version reached the cloud.

## Consequences

- The Supabase Free project remains suitable for the hackathon slice but is not
  a promise of 750 MB for every future account at scale. The deployment owner
  must revisit the allowance before inviting enough accounts to exhaust the
  shared project pool.
- Small standalone parts make upload retries and playback recovery cheaper and
  avoid pretending that concatenated media containers are one valid file.
- Cloud upload takes a reservation, object upload, and finalisation step, so
  retries and expired reservations require explicit handling.
- Concurrent edits require a visible resolution path, but no heuristic merge
  is allowed to become the author of personal story text.

## References

- [Supabase Storage pricing](https://supabase.com/docs/guides/storage/pricing)
- [Supabase Storage access control](https://supabase.com/docs/guides/storage/security/access-control)
- [Supabase file limits](https://supabase.com/docs/guides/storage/uploads/file-limits)
