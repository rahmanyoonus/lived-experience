# Lived Experience

Lived Experience is a private, distraction-free web application for capturing
personal stories by voice or writing. Its product rule is: **Capture first. Make
sense of it later.**

The first local vertical slice is implemented. Guest typing, chunked recording,
device recovery, post-recording transcription review, immutable originals,
version restoration, passwordless email continuation, cloud synchronisation, and the
private story library have working application boundaries and automated
coverage. The selected live Supabase target is `LivedExp`; migrations, schema
linting, and browser configuration are verified. The Atomik Cloudflare Worker
and Static Assets are live, both Worker secrets are configured, and a synthetic
WebM has completed the deployed US-East OpenAI transcription path. Passwordless
email OTP is implemented. Resend custom SMTP is active through the verified
`email.atomik.bn` domain; the sign-in template sends a six-digit code for entry
in the initiating story tab. The application and hosted template are deployed.
The earlier authenticated guest-to-cloud flow was verified end to end with
synthetic text and original audio through the superseded magic-link callback.
A fresh live Gmail OTP delivery, same-tab verification, cloud save, reload, and
private-library retrieval still needs confirmation before the OTP flow is
called live-verified.

Read the [product requirements](./Lived_Experience_PRD_v0.1.md) before making
product or implementation decisions. The technical boundary is recorded in
[ADR 0001](./docs/decisions/0001-application-architecture.md), and the
provider-gated OpenAI transcription decision is recorded in
[ADR 0002](./docs/decisions/0002-openai-transcription-boundary.md). The
approved US-East Worker placement is recorded in
[ADR 0004](./docs/decisions/0004-cloudflare-api-placement.md). The superseded
magic-link decision is recorded in
[ADR 0005](./docs/decisions/0005-passwordless-email-authentication.md). The
failure-only capture readiness policy is recorded in
[ADR 0006](./docs/decisions/0006-capture-readiness-and-degraded-operation.md).
The one-off optional prompt boundary is recorded in
[ADR 0007](./docs/decisions/0007-one-off-prompt-guidance.md).
The private non-chronological story visualisation is recorded in
[ADR 0008](./docs/decisions/0008-private-non-chronological-story-visualisation.md).
The same-tab email OTP decision is recorded in
[ADR 0009](./docs/decisions/0009-same-tab-email-otp.md).

## Current architecture

- React, TypeScript, and Vite for the browser application
- IndexedDB for device-only guest recovery and offline buffering
- Supabase Auth, Postgres, and private Storage for authenticated cloud data
- One Cloudflare Worker with Static Assets and narrow `/api/*` routes
- OpenAI `gpt-4o-mini-transcribe` through the Worker for English transcription
- OpenAI `gpt-5.6-luna` through the Worker for one-off optional prompts

IndexedDB and Supabase are complementary. Guest work stays on the current device
and remains recoverable without a network connection. Supabase is the cloud
persistence layer after passwordless email sign-in. A cloud request cannot
replace the local offline guarantee.

### Capture readiness

The browser silently checks the boundaries that matter before capture:

- a content-free IndexedDB write, read and delete transaction proves that the
  device can currently persist work;
- the optional Storage API estimate reserves 24 MiB of browser headroom for a
  full recording and its bookkeeping;
- a content-free Supabase RPC proves the Data API and current JWT role; and
- `/api/readiness` proves the Worker configuration and current OpenAI model
  reachability without uploading audio.

A healthy check adds no badge, banner or delay message. Device-storage failure
blocks writing and recording because no safe persistence layer exists. Cloud,
session, or transcription failure leaves device-safe capture available and
shows only the relevant warning. Every actual text save and five-second audio
chunk remains an authoritative acknowledgement; a later device write failure
blocks further capture even if the initial check passed.

Direct authenticated deletion is intentionally disabled in this slice. A
future delete action must remove private Storage bytes and database metadata
together after the recovery policy is approved.

### Provider-gated transcription flow

Transcription uses a same-origin, raw-audio request boundary:

1. The browser posts to `/api/transcription-session`. The Worker creates or
   verifies a secret-signed, `HttpOnly`, `Secure`, `SameSite=Strict` browser
   session cookie; the browser never receives the signing secret.
2. Before upload, the browser calculates the standalone audio part's SHA-256
   digest with Web Crypto. It posts the raw media bytes to
   `/api/transcriptions` with the declared byte count, digest, media type,
   language, and logical part coordinates in headers.
3. The Worker validates the request metadata and streams the raw body into the
   OpenAI multipart request while independently counting bytes and calculating
   SHA-256 with `DigestStream`. It completes the multipart body only when the
   streamed byte count and digest exactly match the declarations; a mismatch is
   rejected and the original device copy remains available.

This streaming check avoids buffering another full audio copy in the Worker.
It is an integrity check at the provider boundary, not a claim that a malformed
payload's earlier bytes could never reach the provider before the final digest
is known.

Anonymous quota reservations and logical-segment coordination use
secret-keyed hashes rather than raw browser, network, or segment identifiers.
Their Durable Object rows expire after 30 days; alarms remove expired rows and
deallocate empty coordination storage. This retention applies only to quota and
coordination state, not to story text or original audio.

When confidence cannot be mapped to exact word timing, the complete stored
audio part is the honest review scope. The interface labels it exactly
**Review this part** and provides playback for that part; it never presents an
invented word timestamp.

### One-off prompt guidance

**Guide me with a prompt** requests one still-text question without changing
the selected **Just listen** mode. The browser sends a bounded excerpt from only
the story currently open to same-origin `/api/prompts`. Previous stories are not
read. If the open story is empty or too thin, the Worker asks for a general
prompt about areas such as work, holidays, people, places, practical wisdom, or
clear memories. The result is never inserted into the story and does not create
an empty story or change save state.

The Worker uses structured output, `store: false`, no tools, content-free
errors, a signed-browser and IP quota, a 30-second provider timeout, and the
same monthly OpenAI spend gate as transcription. The implementation and
automated boundary are deployed. Production version
`8a43281f-b92c-4b97-bfc6-ebe31bb418c1` returned both a general prompt for an
empty request and a relevant prompt for a clearly fictional current-story
request. No personal story content was used for verification. **Interview me**
remains disabled for later work.

OpenAI's current data-controls documentation says API data is not used for
training, but default abuse-monitoring logs may contain prompts and responses
for up to 30 days. `store: false` avoids a stored response object; it is not a
Zero Data Retention claim. Zero Data Retention or Modified Abuse Monitoring
requires separate OpenAI approval and configuration.

### Private story visualisation

Authenticated users can open **Visualise my stories** as an optional alternative
to the practical story library. The browser uses the same owner-scoped story
summaries to create a shuffled, slowly moving arrangement of factual titles and
verbatim excerpts. The arrangement does not infer chronology, categories or
relationships, and it never plays audio automatically. People can pause,
resume, shuffle, focus a story and reopen it through the existing safe
open-and-continue path. Reduced-motion preferences produce a static equivalent.

This interaction is implemented locally with React and transform-only CSS; it
does not send story content to another provider and adds no animation runtime.

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`
- npm
- Docker Desktop and Supabase CLI 2.x for local cloud-schema testing

## Set-up

Install the exact dependency versions from the lockfile:

```sh
npm ci
```

The checked-in `.env.example` documents the two browser-visible Supabase values.
Copy it when connecting the selected project:

```sh
cp .env.example .env.local
```

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_replace_me
```

The target project URL is
`https://wrymrogpqptxairnlgpf.supabase.co`. Retrieve its active publishable key
from the same `LivedExp` account; these are public client configuration values,
not privileged server credentials. Never put a Supabase secret or service-role
key in a `VITE_*` variable or committed file.

The Worker reads `OPENAI_API_KEY` and `RATE_LIMIT_SECRET` only from its
server-side environment. A template is provided in `.dev.vars.example`. Never
put either value in `.env.local`, a `VITE_*` variable, or source control.

For an authorised local provider smoke test, create the ignored local file:

```sh
cp .dev.vars.example .dev.vars
```

Enter secrets only in the ignored file, the provider dashboard, or a secure CLI
prompt. Never paste API keys, Supabase secrets, OAuth client secrets, signing
secrets, or other credentials into chat.

## External activation status

The Supabase CLI is linked to `LivedExp` (`wrymrogpqptxairnlgpf`). All reviewed
migrations are applied, and the live `public` schema passes Supabase linting.
The app connector remains stale on an older account, so use the linked CLI for
this project until that connector is re-authenticated.

Wrangler is authenticated to the approved Atomik Cloudflare account. The Worker
and Static Assets deployment is live at the canonical custom domain
`https://livedexp.atomik.bn`; its `workers.dev` and preview URLs are disabled.
Recheck both identities
before future remote writes:

```sh
supabase projects list
npx wrangler whoami
```

The live homepage, configuration health, same-origin browser session, and both
secret bindings are verified. The Worker is placed in `aws:us-east-1` with the
product owner's approval. A synthetic WebM completed the public
`/api/transcriptions` path and received a successful
`gpt-4o-mini-transcribe` response. This verifies live provider reachability and
the application boundary; it does not validate transcription quality for real
speech. See [ADR 0004](./docs/decisions/0004-cloudflare-api-placement.md).

Resend custom SMTP is active in `LivedExp` with the verified sender
`no-reply@email.atomik.bn`. The sending credential is restricted to sending
access and the `email.atomik.bn` domain. The hosted magic-link template uses the
token hash and exact application callback. A synthetic guest story completed
live Gmail delivery, same-browser callback, private cloud acknowledgement,
reload to a fresh capture canvas, private-library retrieval, and reopening from
cloud without duplication or sync error. A recovered story with an original
recording then completed the same guest-to-account path after the
reserved-object Storage insert policy was repaired; the live app acknowledged
both the story and its original audio as private account data.

## Local Supabase

Start the isolated local services:

```sh
supabase start
```

Rebuild the database from the committed migrations:

```sh
supabase db reset --local --no-seed --yes
```

The local API uses `http://127.0.0.1:56321` and Studio uses
`http://127.0.0.1:56323`. Configure the browser with the local publishable key
reported by `supabase status`; do not use or expose the reported secret key.
Local email OTP messages are captured by the local Supabase mail viewer. The
committed template uses `{{ .Token }}` and the app verifies the six-digit code
with the email address in the same browser tab. No authentication callback or
redirect allowlist is required for this flow. Only the story identifier, cursor
range, and one-hour expiry are retained locally while verification is pending;
the email address stays in dialog memory.

## Development

### Hackathon example story

On an untouched capture canvas, select **Use example text** to add a clearly
fictional story. It becomes an ordinary editable draft and follows the same
device-only or cloud autosave path as typed content. The action disappears as
soon as a story has started, so it cannot replace existing work.

Start the local Vite development server:

```sh
npm run dev
```

Create a production build:

```sh
npm run build
```

Preview the production build locally:

```sh
npm run preview
```

## Verification

Run the automated tests once:

```sh
npm test
```

Run tests in watch mode:

```sh
npm run test:watch
```

Run linting and TypeScript checks:

```sh
npm run lint
npm run typecheck
```

Validate the Supabase schema and row-level security contracts:

```sh
supabase db lint --local --fail-on error --schema public
supabase test db --local
```

After deploying both boundaries, verify the content-free live probes:

```sh
curl -fsS https://livedexp.atomik.bn/api/health
curl -fsS https://livedexp.atomik.bn/api/readiness
```

Run the complete currently available local verification set:

```sh
npm run lint
npm run typecheck
npm test
npm run build
supabase db lint --local --fail-on error --schema public
supabase test db --local
```

## Cloudflare commands

Generate Cloudflare binding types after the Worker configuration exists or
changes:

```sh
npm run cf-typegen
```

The deployment script is:

```sh
npm run deploy
```

Check the deploy bundle without publishing:

```sh
npx wrangler deploy --dry-run
```

Before future publishes, recheck the approved Cloudflare account, environment,
routes, placement, and secret bindings.

## Accepted operating limits

This version uses:

- current Chrome, Safari, and Edge on desktop, Chrome on Android, and Safari on
  iOS;
- English transcription and 30-minute user-created spoken segments;
- 30-day device-only guest retention;
- internal standalone transcription parts no longer than four minutes or
  20,000,000 bytes, while retaining one logical spoken segment;
- at most two provider attempts for each immutable recording part;
- three segments per hour and ten per day per browser, plus twenty per hour per
  IP, with a ten-minute client workflow deadline;
- ten prompts per hour and thirty per day per browser, plus one hundred per
  hour per IP, with a 35-second client workflow deadline;
- a US$50 monthly OpenAI ceiling, enforced by stopping new calls at US$49 to
  preserve a US$1 safety margin;
- 750,000,000 bytes of authenticated audio per account; and
- preservation of both candidates when concurrent edits conflict, with no
  automatic merge.

The 750,000,000-byte value is an exact decimal-byte cap, not an approximate
binary-unit allowance.

## Remaining activation decisions

Before a public launch, decide or verify:

- the `LivedExp` backup policy and production access controls;
- whether the approved US-East Worker placement remains appropriate for
  production and whether to enable Zero Data Retention later;
- representative prompt-guidance evaluation cases, later interview questions,
  and factual-title prompts;
- production-environment separation beyond the canonical Cloudflare domain;
- any server-side conversion fallback if a supported browser produces audio
  that OpenAI does not accept; and
- privacy, consent, age, deletion-recovery, and jurisdictional policies.

## Known launch risks

- The supported-browser list is a target matrix, not completed real-device
  evidence. The physical desktop Chrome, Safari, and Edge, Android Chrome, and
  iOS Safari capture/reload/authentication matrix still needs to be run.
- The Worker validates the client's part duration and logical timeline metadata
  but does not independently parse the raw media container to establish actual
  audio duration. To protect the cost ceiling meanwhile, every admitted
  provider call reserves the full four-minute part allowance. Server-side media
  duration parsing or an approved equivalent remains a launch-hardening task.
- The authenticated text and original-audio cloud paths are live-verified in
  desktop Chrome. The remaining physical-browser matrix below is still needed
  before launch.
- Only synthetic provider-boundary traffic has been verified against live
  OpenAI. Real-device recording and transcription remain part of the physical
  browser matrix, and the US-East placement requires review before production
  privacy commitments.
