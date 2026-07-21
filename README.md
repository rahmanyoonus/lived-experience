# Lived Experience

Lived Experience is a private, distraction-free web application for capturing
personal stories and memories by voice or writing, assisted by AI.

## OpenAI Build Week submission

**Track:** Apps for Your Life

Famous lives are remembered, while countless others go unheard. Lived
Experience helps people preserve their stories, work, and hard-won wisdom in
their own words and voice, with AI available only by invitation.

Unlike an AI memoir writer, the application does not summarise, polish, split,
categorise, or reinterpret a person's story. It reduces the friction of
starting, protects unfinished work from common browser and network failures,
and keeps the teller in control of every edit.

## Demo

- Live application: <https://livedexp.atomik.bn>
- Source repository: <https://github.com/rahmanyoonus/lived-experience>
- Video demo: to be added to the Devpost submission

No shared credentials are required. Use only fictional content when testing.
The fastest safe path is:

1. Open the live application and select **Use example text** on the untouched
   canvas.
2. Edit the fictional story and observe the device save state.
3. Select **Guide me with a prompt** to request one optional GPT-5.6 question.
4. Optionally record and explicitly stop a short English voice segment; the
   transcript appears only after processing.
5. Select **Keep this story** and enter the six-digit email code in the same
   browser tab.
6. Open **Your Stories** or **Visualise my stories** to retrieve the private
   retained story.

## How we used Codex

Codex was used throughout OpenAI Build Week as a repository-aware engineering
collaborator. It helped us:

1. Turn the PRD's trust requirements into explicit capture, recovery, and sync
   states.
2. Design the browser-first IndexedDB, Supabase, and Cloudflare Worker
   architecture.
3. Implement guest recording, transcription review, version history,
   authentication, cloud migration, and optional guidance.
4. Reproduce and fix persistence, Storage-policy, authentication, and
   deployment failures.
5. Build and expand the automated application, Worker, and database tests.
6. Review privacy boundaries, accessibility, responsive behaviour, and
   truthful product copy.
7. Deploy and verify the live Cloudflare and OpenAI boundaries.

We made the final product and provider decisions. Nine ADRs record the
consequential choices and their limitations. 

## How we used GPT-5.6

Lived Experience uses `gpt-5.6-luna` for the optional **Guide me with a
prompt** action. The model receives either no story content or a bounded excerpt
from only the story currently open. It returns one short, open-ended question
as schema-validated structured output.

GPT-5.6 is valuable here because a useful question must understand incomplete,
conversational context while avoiding leading narratives, invented facts,
diagnosis, judgement, or instructions embedded inside the story text. A fixed
template cannot reliably make those distinctions.

The Worker treats story text as untrusted data, uses `store: false`, enables no
tools, imposes input and output bounds, validates the response schema, applies
timeouts, rate limits, and a spend gate, and keeps prompts and outputs out of
routine logs. The question is never inserted into the person's story and can be
dismissed without changing it.

## What was built during OpenAI Build Week

There was no pre-existing application code. The repository began during Build
Week with the product requirements and agent guardrails. We built the React capture UI, IndexedDB recovery, chunked
recording, post-stop transcription, original-artefact and version recovery,
Supabase schema and Storage policies, email authentication, idempotent
guest-to-cloud migration, Cloudflare Worker API, rate and spend controls,
GPT-5.6 prompt guidance, private library, story visualisation, automated tests,
deployment, and live synthetic verification.


## Known limitations

- The initial transcription language is English.
- A fresh real-inbox, same-tab OTP verification through cloud save, reload, and
  private-library retrieval remains a final live validation item.
- Deletion recovery, permanent deletion, export, backup, and account-recovery
  policies require approval before a wider launch.
- The story visualisation is private presentation only; it does not infer
  themes, timelines, or relationships.

## Licence

This project is available under the [MIT License](./LICENSE).

The first local vertical slice is implemented. Guest typing, chunked recording,
device recovery, post-recording transcription review, immutable originals,
version restoration, passwordless email continuation, cloud synchronisation, and the
private story library have working application boundaries and automated
coverage. The selected live Supabase target is `LivedExp`; migrations, schema
linting, and browser configuration are verified. The Atomik Cloudflare Worker
and Static Assets are live, both Worker secrets are configured, and a synthetic
WebM has completed the deployed OpenAI transcription path. Passwordless
email OTP is implemented. 

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
- OpenAI `gpt-4o-mini-transcribe` through the Worker for transcription
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
- a content-free Supabase RPC proves the Data API and current JWT role


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
automated boundary are deployed.


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

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_replace_me
```


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


Run the complete currently available local verification set:

```sh
npm run lint
npm run typecheck
npm test
npm run build
supabase db lint --local --fail-on error --schema public
supabase test db --local
```
