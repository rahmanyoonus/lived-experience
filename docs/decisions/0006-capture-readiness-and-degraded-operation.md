# ADR 0006: Capture readiness and degraded operation

- **Status:** Accepted
- **Date:** 21 July 2026
- **Decision owners:** Product owner and implementation team

## Context

A person may speak or write for a long time before noticing that cloud saving
or another provider is unavailable. The product must not imply that work is
safe unless its promised persistence layer has acknowledged it. At the same
time, network trouble must not place a sign-in or availability gate in front of
capture when device recovery is working.

Browser connectivity hints are not sufficient evidence: a device can report
online while the required service is unreachable, and a service can be healthy
while IndexedDB is unavailable or full.

## Decision

Run silent, content-free readiness checks for device storage, Supabase and the
transcription boundary. A healthy system adds no visible readiness state.

Device readiness is authoritative for beginning capture. Prove it with an
IndexedDB write, read and delete in one committed transaction, then use the
browser storage estimate when available to require 24 MiB of headroom. Do not
create an empty story during this check. Recheck immediately before microphone
capture and continue treating every text save and audio chunk acknowledgement
as authoritative.

If device persistence cannot be proved, explain the problem and disable writing
and recording. Do not allow knowingly unsaved capture.

Cloud and transcription readiness are advisory while device persistence is
safe. Probe Supabase through a narrowly granted, content-free RPC and validate
an authenticated session through the Auth server. Probe the Worker and OpenAI
model boundary without sending audio. Warn only when a boundary is degraded;
keep capture available locally and preserve truthful **Saved locally** or
**Not yet synced** status.

Keep all readiness requests, responses, logs and tests free of story text,
transcripts, audio, email addresses, tokens and signed media URLs.

## Consequences

- People are stopped before capture only when the application cannot provide
  its minimum device-recovery guarantee.
- Network and provider incidents do not prevent private offline capture.
- A readiness check reduces risk but does not replace continuous autosave,
  chunking, explicit acknowledgements or retryable cloud synchronisation.
- The Worker caches provider readiness briefly to avoid probing OpenAI on every
  page load while still detecting incidents promptly.
- Production verification exposed migration drift in the private Storage
  insert policy. The repair authorises only the current user's exact,
  unexpired reserved object path; cloud acknowledgement still requires the
  final byte count, SHA-256 digest and part metadata to match the reservation.

## Verification

Test healthy invisibility, device failure blocking, low-storage blocking,
cloud-degraded local capture, voice-only transcription warnings, session
failure, reconnect and retry, and the absence of content in readiness payloads.
Run the full application, Worker and Supabase contract suites before release.
