# OpenAI Build Week Devpost submission draft

This draft is written for the actual Devpost fields in the **Lived Experience**
submission. Replace every angle-bracket placeholder before submitting.

## Project overview

### Project name

Lived Experience

### Elevator pitch

199 characters:

> Famous lives are remembered. Countless others go unheard. Lived Experience lets people privately speak or write their stories—preserving their words, voice and hard-won wisdom, with AI by invitation.

### Category

**Apps for Your Life**

The primary user is an individual preserving their own memories, work and
wisdom. This is a personal-life product, not a workplace or developer tool.

## Project details

### About the project

```md
## Inspiration

There are histories we all know because someone took the time to preserve them. But most lives—our parents, grandparents, carers, craftspeople, colleagues and neighbours—are carried only in memory. They can disappear because telling a life story feels like writing a book: too formal, too large, and too easy to postpone.

Voice recorders remove the writing barrier, but leave hours of audio that are difficult to review or continue. Writing apps begin with a blank page. Many AI products rush ahead of the person—summarising, polishing and organising before they have finished remembering.

We wanted to build the opposite: a private place that gets out of the way and faithfully preserves what a person meant to say.

Our product rule became: **Capture first. Make sense of it later.**

## What it does

Lived Experience opens directly to a fresh story canvas. There is no sign-up gate, onboarding questionnaire or demand for a title. A person can start typing immediately or begin recording after choosing the microphone.

The recording experience stays deliberately calm. Recording starts and stops only through explicit action; silence does not stop it, and no live transcript competes for attention. Audio is saved locally in small chunks. Only after the person stops and processing completes does a faithful, editable transcript appear.

The system keeps the original audio, first transcript and later edits as separate recoverable artefacts. Autosave states tell the truth: guest work is saved on this device; authenticated work is only called **Saved** after the cloud acknowledges it. If a network or sync step fails, the local recovery copy remains available.

When the person chooses **Keep this story**, a six-digit email code is entered in the same browser tab so authentication does not unexpectedly navigate away from the active story. The guest-to-account transfer is designed to be idempotent and safe to retry. Retained stories can be reopened from a private library or rediscovered through an optional, non-chronological visualisation that never invents themes or relationships.

**Just listen** remains the default. If the person wants help, **Guide me with a prompt** asks GPT-5.6 for one short, open-ended question using only a bounded excerpt from the story currently open. The question is never inserted into the story, never changes the capture mode and never reads previous stories. The person can dismiss it and keep writing.

## How we built it

We built Lived Experience as a browser-first reliability system, not a chat wrapper:

- React, TypeScript and Vite provide the capture experience.
- IndexedDB through Dexie stores guest text, five-second recording chunks, transcripts and recovery state on the current device.
- Supabase Auth, Postgres and private Storage provide owner-scoped cloud persistence after sign-in, with row-level security and idempotent migration.
- One Cloudflare Worker with Static Assets serves the application and owns the narrow OpenAI boundary.
- `gpt-4o-mini-transcribe` produces English transcripts only after recording stops.
- `gpt-5.6-luna` powers optional one-question guidance through the Responses API with structured output, `store: false`, no tools, bounded context, timeouts, rate limits and a shared spend ceiling.
- Durable Objects coordinate anonymous quotas without storing raw story text, audio or content-bearing identifiers.

The transcription route creates a secret-signed browser session, checks declared size and SHA-256 integrity while streaming audio to OpenAI, and rejects mismatches without deleting the device copy. Story content is kept out of routine logs, analytics, quota records and automated fixtures.

Codex was our engineering partner throughout Build Week. It helped turn the product requirements into an explicit capture and persistence state model; design the IndexedDB/Supabase boundary; implement and test recording, sync, authentication and Worker routes; investigate live deployment failures; refine the desktop and mobile experience; and verify the deployed boundaries. We reviewed consequential choices and recorded them in nine architecture decision records rather than allowing generated code to silently define the product.

GPT-5.6 is not decorative. Its live task is to understand a small amount of messy, personal context and return one relevant but non-leading question. Simple templates cannot reliably distinguish between thin context, a concrete memory and text that tries to instruct the model. The Worker treats story text as untrusted data, requires schema-valid structured output and gives the person complete control over whether to answer.

## Challenges we ran into

The hardest problem was making every promise in the interface correspond to a real persistence guarantee. IndexedDB must protect a guest from reloads and network failures, while Supabase must make an authenticated story available across sessions. We had to migrate without refreshing, duplicating or deleting the local source before the cloud acknowledged it.

Audio introduced a second reliability problem. A long recording cannot be one fragile in-memory blob, but provider requests still need ordered, verifiable media. We chunk locally, retain the original artefacts and validate byte count and digest at the Worker boundary while streaming.

Authentication taught us that a technically valid flow can still violate the capture experience. We first implemented email magic links, then replaced them with a six-digit OTP entered in the initiating tab so the person's active story and cursor context stay put.

The final challenge was restraint. It was easy to add summaries, categories, animated transcripts or always-on AI. It was harder—and more important—to prove that optional AI, truthful status language and calm interaction can produce a more trustworthy product.

## Accomplishments that we're proud of

We moved from a product brief to a deployed capture-to-cloud vertical slice during Build Week.

The current build supports immediate guest typing and recording, incremental local recovery, post-recording transcription, immutable originals, editable version history, same-tab email OTP, private cloud sync, a story library, a private non-chronological visualisation and optional GPT-5.6 guidance.

The deployed Worker health and readiness probes pass, the OpenAI transcription boundary has completed a clearly synthetic request, and GPT-5.6 guidance has been live-verified with both an empty request and a clearly fictional current story. Our final local run passed **158 application tests and 63 Worker tests (221 total)**, plus linting, TypeScript checks and a production build.

Most of all, the product behaves according to its values: it lets someone begin before creating an account, never shows a transcript while they are speaking, does not stop on silence, preserves originals and never calls device-only work cloud-saved.

## What we learned

Privacy is not a paragraph in a policy. It is a state machine, an architecture and a set of words the interface must earn.

Local-first and cloud persistence are not competing choices when the promises are different: the device protects immediate capture, while the cloud protects retained account access.

We also learned that useful AI does not have to be loud. The most important model decision was not how much GPT-5.6 could generate, but when it should remain silent and how the person could stay in control.

Codex was most valuable as a repository-aware collaborator across the whole loop—requirements, architecture, implementation, testing, debugging, deployment and review—not as a one-shot code generator.

## What's next for Lived Experience

Before a wider pilot, we will complete controlled real-inbox and cross-browser validation of the same-tab OTP journey, test transcription with consented speakers and a wider range of accents, and finish the privacy, deletion, export and retention decisions required for sensitive personal material.

We will keep the same boundary as we grow: capture and recovery first. Later guidance may reference earlier stories only through explicit session permission and visible source links. Organisation, long-form outputs or sharing will be separate user choices, never an automatic reinterpretation of someone's life.
```

### Built with tags

Use these tags (19 of the allowed 25):

1. Codex
2. GPT-5.6
3. OpenAI API
4. GPT-4o mini Transcribe
5. React
6. TypeScript
7. Vite
8. Cloudflare Workers
9. Cloudflare Durable Objects
10. Wrangler
11. Supabase
12. Supabase Auth
13. PostgreSQL
14. Supabase Storage
15. IndexedDB
16. Dexie
17. MediaRecorder API
18. Zod
19. Vitest

### Try it out links

- Live application: <https://livedexp.atomik.bn>
- Code repository: `<ADD_REPOSITORY_URL>`

### Video demo link

`<ADD_PUBLIC_OR_UNLISTED_YOUTUBE_URL>`

## Additional information for judges

### Submitter type

Select **Individual** only if there are no other contributors to add. Otherwise
select **Team of Individuals** and make sure every invitation is accepted.

### Country of residence

Select **Brunei Darussalam** if that is the submitter's country of residence.

### Testing instructions

```text
Live demo: https://livedexp.atomik.bn

The app opens to a fresh capture canvas without authentication.

Fastest safe test path:
1. Select “Use example text” on the untouched canvas. This inserts a clearly fictional story through the normal editable autosave path.
2. Edit the text and observe the device save state.
3. Select “Guide me with a prompt” to request one optional GPT-5.6 question. The prompt is not inserted into the story and can be dismissed.
4. To test voice, select “Start recording”, approve microphone access, speak, and stop explicitly. No live transcript appears; processing begins only after stop.
5. Select “Keep this story” and use an email address you can access. Enter the six-digit code in the same tab.
6. Open “Your Stories” to retrieve the retained story, or “Visualise My Stories” for the private non-chronological view.

No shared credentials are required. Please use only fictional test content. The initial transcription language is English. “Interview me” is intentionally not part of this version.
```

### Codex feedback Session ID

`<ADD_PRIMARY_FEEDBACK_SESSION_ID>`

Use the Session ID from the Codex task where the majority of the core
functionality was built. Do not substitute the visible Codex task ID unless the
`/feedback` command explicitly returns it.

## README copy required by the rules

The current README needs explicit hackathon sections before the repository is
submitted. The following can be adapted into it.

### How we used Codex

```md
## How we used Codex

Codex was used throughout OpenAI Build Week as a repository-aware engineering collaborator. It helped us:

1. Turn the PRD's trust requirements into explicit capture, recovery and sync states.
2. Design the browser-first IndexedDB, Supabase and Cloudflare Worker architecture.
3. Implement guest recording, transcription review, version history, authentication, cloud migration and optional guidance.
4. Reproduce and fix persistence, Storage-policy, authentication and deployment failures.
5. Build and expand the automated application, Worker and database tests.
6. Review privacy boundaries, accessibility, responsive behaviour and truthful product copy.
7. Deploy and verify the live Cloudflare and OpenAI boundaries with synthetic content.

We made the final product and provider decisions. Nine ADRs record the consequential choices and their limitations.

Primary `/feedback` Session ID: `<ADD_PRIMARY_FEEDBACK_SESSION_ID>`
```

### How we used GPT-5.6

```md
## How we used GPT-5.6

Lived Experience uses `gpt-5.6-luna` for the optional **Guide me with a prompt** action. The model receives either no story content or a bounded excerpt from only the story currently open. It returns one short, open-ended question as schema-validated structured output.

GPT-5.6 is valuable here because a useful question must understand incomplete, conversational context while avoiding leading narratives, invented facts, diagnosis, judgement or instructions embedded inside the story text. A fixed template cannot reliably make those distinctions.

The Worker treats story text as untrusted data, uses `store: false`, enables no tools, imposes input/output bounds, validates the response schema, applies timeouts, rate limits and a spend gate, and keeps prompts and outputs out of routine logs. The question is never inserted into the person's story and can be dismissed without changing it.
```

### What was built during Build Week

```md
## What was built during OpenAI Build Week

The repository began during Build Week with the product requirements and agent guardrails. The working application was built during the event: the React capture UI, IndexedDB recovery, chunked recording, post-stop transcription, original-artefact and version recovery, Supabase schema and storage policies, email authentication, guest-to-cloud migration, Cloudflare Worker API, rate and spend controls, GPT-5.6 prompt guidance, private library and story visualisation, automated tests, deployment and live synthetic verification.
```

### Known limitations

```md
## Known limitations

- The initial transcription language is English.
- **Interview me** and cross-story guidance are intentionally deferred.
- A fresh real-inbox, same-tab OTP verification through cloud save, reload and private-library retrieval remains a final live validation item.
- OpenAI Zero Data Retention is not enabled. `store: false` prevents a stored Responses object, but default provider abuse-monitoring retention may still apply.
- Deletion recovery, permanent deletion, export, backup and account-recovery policies require approval before a wider launch.
- The story visualisation is private presentation only; it does not infer themes, timelines or relationships.
```

## Final submission blockers

Resolve these before selecting **Submit**:

- Add a repository remote and provide an accessible repository URL. The current
  local Git repository has no remote configured.
- Add the required Codex, GPT-5.6, Build Week and limitations sections to the
  README.
- Run `/feedback` in the representative Codex task and paste the returned ID.
- Record and upload a narrated public or unlisted YouTube demo under three
  minutes.
- Add a 3:2 project thumbnail and, ideally, three concise gallery screenshots.
- Select the submitter type, country and **Apps for Your Life** category.
- Add the repository and live-demo testing instructions.
- Recheck that Devpost says **Submitted**, then open the public project page and
  verify the live, video and repository links.
