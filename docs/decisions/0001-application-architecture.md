# ADR 0001: Application architecture

- **Status:** Accepted; authentication decision superseded by ADR 0005
- **Date:** 19 July 2026
- **Decision owners:** Product owner and implementation team

## Context

The first vertical slice must prove immediate guest capture, local recovery,
faithful post-recording transcription, account sign-in, and private cloud
persistence. It must also keep provider-specific code behind narrow boundaries
and avoid claiming that content is cloud-saved before the cloud has acknowledged
it.

Guest capture and authenticated capture have different persistence needs. An
unsigned story must survive a reload or browser restart on the same device and
must continue to work through a network interruption. Authenticated stories must
be available through the user's private cloud library. A remote database cannot
provide the first guarantee when the browser is offline, while browser-only
storage cannot provide the second.

## Decision

### Web application

Build the client as a React and TypeScript application using Vite. Support the
current versions of:

- Chrome, Safari, and Edge on desktop;
- Chrome on Android; and
- Safari on iOS.

The initial transcription language is English. The editor and persistence
layers must still preserve Unicode text without modification.

### Local and cloud persistence

Use browser IndexedDB for guest stories and as the local recovery and offline
buffering layer. An unsigned guest draft is retained on that device for 30 days
and must be described as device-only. The implementation must not create an
empty draft before the first typed character or recording begins.

Use Supabase for the authenticated cloud boundary:

- Supabase Auth for the approved first-version sign-in method;
- Postgres for private story metadata, original transcript references, current
  content, and version history; and
- private Supabase Storage buckets for original audio and other private binary
  artefacts.

Supabase does not replace IndexedDB. It is a network service and therefore
cannot satisfy guest recovery and offline buffering by itself. Using anonymous
cloud identities for guests would also change the approved device-only guest
promise.

Guest-to-account migration must be idempotent and safe to retry. IndexedDB data
is removed only after the corresponding authenticated data has been
acknowledged by the cloud persistence layer. The browser must never receive a
Supabase service-role or secret key. Every exposed table and private storage
bucket requires ownership-based access control and row-level security before a
live project is connected. Once cloud storage is introduced, private text and
audio must be encrypted in transit and at rest.

### Cloudflare application boundary

Deploy one Cloudflare Worker with Static Assets. The Worker serves the built
Vite application and owns a small `/api/*` surface for operations that need
server-held credentials or policy enforcement, such as transcription. Do not
create a separate Cloudflare Pages project or Pages Functions application for
this version.

Cloudflare Pages could host the static client, but combining Pages Functions
with a separate Worker would introduce an additional runtime and deployment
boundary without helping the first vertical slice. A Worker with Static Assets
keeps static delivery and the narrow API in one deployment while Supabase
remains the private data service.

### Recording and transcription

- Request microphone permission only after the user chooses voice capture.
- Once permission is approved, begin recording without requiring a second start
  action.
- End a segment only through explicit user action. Silence must not stop or
  split it.
- Keep the recording surface visually still: no live transcript, moving
  waveform, animated words, or uncontrolled layout changes.
- Limit a spoken segment to 30 minutes for the initial version. The product must
  communicate the limit without implying that silence will stop recording.
- After a segment stops, keep typing available while transcription is
  processing.
- Do not allow another recording to start until the current segment has
  finished processing.
- Reveal the transcript only after processing completes.

Off-device transcription may use a temporary copy of the audio encrypted in
transit and at rest, subject to explicit approval of the provider and its
data-handling terms. The chosen provider must not use story content for general
model training, and the temporary provider copy must be deleted after
processing. The original audio remains immutable in the application's approved
persistence layer unless the user deletes it.

### Provider boundaries

Keep authentication, database access, object storage, transcription, and later
AI guidance behind narrow interfaces. Prompts, provider responses, and any
transformation of story display text must have an explicit, testable provenance
boundary. Raw story text, transcripts, recordings, and content-bearing prompts
must not enter routine logs, analytics, error reports, or test fixtures.

## Consequences

- Guest and offline reliability require a deliberate reconciliation path
  between IndexedDB and Supabase rather than one universal persistence API.
- The user-facing save state must be driven by acknowledged persistence:
  **Saved locally** for IndexedDB and **Saved** only after Supabase confirms the
  authenticated write.
- The single Worker deployment reduces operational surfaces, but Supabase is
  still a separate managed service with its own region, access controls, and
  operational configuration.
- Thirty-minute recordings require incremental local buffering or chunking so a
  long segment is not one catastrophic point of failure.
- The scaffold may expose explicit unconfigured provider adapters, but it is not
  the approved end-to-end slice until account sign-in, transcription, storage,
  and deployment are configured and verified against live services.

## Activation status and remaining decisions

The production target is Supabase project `LivedExp`
(`wrymrogpqptxairnlgpf`). Its region, migrations, publishable browser key,
hosted authentication configuration and live row-level-security behaviour must still be
verified before activation. The current Supabase app connector is still
authenticated to a previous account and returns no permission for this target;
do not apply the migrations to one of the connector's older projects. The
current Wrangler session resolves to an existing Clickr Cloudflare account, not
the newly intended Lived Experience account; do not deploy from that session.
Reconnect both services and verify the target identities before any remote
write. Credentials must be entered only through ignored local files, provider
dashboards, or secure CLI prompts, never pasted into chat.

ADR 0002 records the accepted OpenAI transcription provider, model, request
controls, data-handling basis, and US$50 monthly ceiling. ADR 0003 records the
exact 750,000,000-byte per-account audio cap and the preserve-both conflict
policy.

The following choices remain intentionally unresolved:

- Supabase hosting region, data-processing terms, backup policy, and production
  access controls;
- OpenAI processing geography and any later Zero Data Retention activation;
- AI provider for prompts, guidance, and factual title generation;
- Cloudflare account, deployment environments, custom domain, and production
  secrets;
- story-deletion recovery window and permanent-deletion policy;
- version snapshot frequency and restoration retention;
- accepted browser audio formats and any server-side conversion policy;
- privacy notice, consent language, age policy, and jurisdictional review; and
- quantitative reliability, performance, accessibility, and success targets.

These decisions must be presented for approval rather than inferred from the
selected services.

Shared-device guest recovery and account-switch behaviour are explicitly
deferred for this first version. They are not activation blockers for the
single-person, single-browser slice and must not be expanded without a later
product decision.
