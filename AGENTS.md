# AGENTS.md

## Purpose

This repository contains the Lived Experience web application: a private,
distraction-free place where people can capture personal stories by speaking or
writing at their own pace.

The primary product reference is
[`Lived_Experience_PRD_v0.1.md`](./Lived_Experience_PRD_v0.1.md). Read it before
making product, design, architecture, data, or AI-behaviour decisions. If an
implementation choice conflicts with the PRD, preserve the PRD behaviour and
surface the conflict rather than silently changing the product.

## Current repository state

The repository now contains the first provider-gated vertical slice. React,
TypeScript, and Vite provide the browser application; IndexedDB provides guest
recovery; Supabase adapters and migrations provide the authenticated
cloud boundary; and one Cloudflare Worker with Static Assets provides the
deployment and OpenAI transcription boundary. See `README.md` and the ADRs in
`docs/decisions/` for the approved architecture and unresolved activation
decisions.

- The target Supabase project is `LivedExp` (`wrymrogpqptxairnlgpf`). Its
  migrations are applied, the live schema passes linting, and the browser
  configuration is connected. The Atomik Cloudflare Worker, required secrets,
  `aws:us-east-1` placement, and a synthetic Worker-to-OpenAI transcription are
  live and verified. Passwordless email OTP is selected for the
  hackathon. Resend custom SMTP is active through the verified
  `email.atomik.bn` domain, the hosted six-digit OTP template is configured,
  and the same-tab OTP application flow is deployed. The earlier synthetic
  text and original-audio guest-to-cloud paths were live-verified through the
  superseded magic-link callback. A fresh live Gmail OTP delivery, same-tab
  verification, cloud save, reload, and private-library recovery remains to be
  confirmed before describing the OTP flow as live-verified. One-off **Guide
  me with a prompt** guidance is deployed and
  live-verified with both empty and clearly fictional current-story requests;
  **Interview me** remains disabled. Do not imply that another unverified
  adapter or flow is live.
- OpenAI Zero Data Retention is deferred. The accepted transcription boundary
  relies on the current documented defaults for `/v1/audio/transcriptions`;
  re-check those defaults before sending personal story audio or launching
  publicly, and whenever the endpoint or provider policy changes. Prompt
  guidance uses `/v1/responses` with `store: false`, but OpenAI's documented
  default abuse-monitoring logs may contain prompts and responses for up to 30
  days unless approved retention controls are enabled. Do not describe prompt
  guidance as Zero Data Retention.
- Record consequential and difficult-to-reverse choices in a short ADR under
  `docs/decisions/`.
- Use `npm run dev`, `npm run lint`, `npm run typecheck`, `npm test`, and
  `npm run build` for application work. Use the exact Supabase and Wrangler
  verification commands documented in `README.md`.

## Product north star

> Capture first. Make sense of it later.

The product succeeds when it gets out of the way and faithfully preserves what
the person meant to say. Optimise first for ease of capture, trust, recoverability,
and user control—not clean metadata, engagement mechanics, or AI output volume.

## Non-negotiable MVP behaviour

All implementation work must preserve these decisions:

- Open directly to a fresh capture canvas. Do not place a sign-up gate,
  onboarding questionnaire, dashboard, or unfinished-story chooser in front of
  capture.
- Let a guest type or begin recording before creating an account.
- Keep **Just listen** as the default. **Interview me** and **Guide me with a
  prompt** must remain clearly available and optional.
- Keep the screen visually calm while recording. Do not show a live transcript,
  animated words, reactive audio visualisation, or distracting layout changes.
  One minimal, muted sine wave may move only while recording to confirm that
  capture is active; it must become static when reduced motion is requested.
- Recording begins and ends through explicit user action. Silence must not stop
  or split a recording.
- Show the transcript only after the spoken segment has stopped and processing
  has completed.
- Make transcripts faithful but readable: punctuation, capitalisation, and
  paragraph breaks are allowed by default; removing words, rewriting grammar,
  polishing vocabulary, or changing meaning is not.
- Allow direct editing while keeping original audio, the original transcript,
  and meaningful version history recoverable.
- Treat the primary record as one user-created story. A story may contain several
  subjects or memories; do not automatically split, merge, or warn about it.
- Autosave continuously. Guest work is stored locally and labelled as
  device-only; authenticated work is cloud-saved with truthful status.
- Offer a non-blocking **Keep this story** action after content exists.
  Passwordless email OTP entered in the initiating browser tab is the only
  hackathon first-version sign-in method; Google OAuth is deferred.
- Transfer the active guest story through authentication without refresh-related
  loss, duplication, or unexpected navigation.
- Make use of previous stories during guidance explicit and user-controlled.
  Cross-story questions must identify and link their source story.
- Keep stories private by default. The MVP has no public URL, publishing,
  discovery, social, or sharing surface.

## AI rules

AI assists capture; it does not become the author.

- Preserve the speaker's vocabulary, repetitions, filler words, false starts,
  tone, and meaning unless the user explicitly asks for editing.
- Mark uncertain transcription and provide a path back to the audio. Do not
  silently guess.
- Never interrupt active recording or begin speaking automatically.
- Present one guidance question at a time and wait for the user's action.
- Do not infer a preferred life narrative, diagnosis, moral judgement, or lesson.
- Do not categorise or organise material inside the capture flow.
- Generate only short, factual library titles. Failure to generate a title must
  never block saving; use the date and excerpt as the fallback.
- Do not use earlier stories unless **Explore past stories** is visibly enabled
  for the session. Allow the user to disable it at any time.
- Keep model prompts, outputs, and provenance testable. Where AI modifies display
  text, the transformation boundary must be explicit in code.

## Data and trust invariants

Treat captured stories as sensitive personal data.

- Original audio is the source of truth and remains immutable unless the user
  deletes it.
- The first faithful transcript remains recoverable after later edits.
- The current story is directly editable. Restoring an earlier version creates a
  new current version rather than destroying later work.
- Do not create an empty story record before the first typed character or
  recording begins.
- Guest autosave must survive an accidental reload or browser restart on the same
  supported device.
- Guest-to-account migration must be idempotent and safe to retry.
- Never show **Saved** unless the acknowledged content has reached its promised
  persistence layer. Distinguish **Saving**, **Saved locally**, **Saved**, and
  **Not yet synced**.
- Buffer or chunk long recordings so one network or browser failure cannot cause
  catastrophic loss.
- Encrypt private text and audio in transit and at rest once cloud storage is
  introduced.
- Keep raw story text, transcript content, audio, and content-bearing prompts out
  of analytics, routine logs, error reports, and telemetry.
- Do not use story content for general model training without explicit, informed
  opt-in.
- Do not log secrets, tokens, signed media URLs, or personal story content in
  tests and fixtures.
- Use synthetic, clearly fictional stories in automated tests and screenshots.

## UX and accessibility

- The capture canvas is the primary surface; account, settings, and library
  controls are secondary.
- Use calm, plain, non-judgemental language. Do not present the application as
  therapy or make clinical claims.
- Use British English in product copy and documentation unless localisation
  requirements say otherwise.
- Do not use colour alone to communicate recording, save, offline, or error
  states.
- Every voice path needs an equivalent text path.
- Core controls must work with keyboard and screen readers and have descriptive
  accessible names.
- Honour reduced-motion preferences. The core recording experience should not
  require motion in the first place.
- Preserve Unicode and treat accents, code-switching, hesitations, and
  non-standard grammar as normal speech rather than mistakes to fix.
- Design and test at both desktop and mobile browser widths.

## MVP boundary

Do not add the following without an explicit change to product scope:

- public profiles, publishing, discovery, social interactions, or sharing;
- automatic categories, themes, timelines, story connections, or memoir output;
- automatic story splitting or merging;
- photo, document, letter, or video attachments;
- reminders, nudges, streaks, scores, word counts, or completion pressure;
- Apple sign-in, mobile-number sign-in, or native mobile applications;
- rich-text formatting or writing templates; or
- automatic polishing, summarisation, lesson extraction, or narrative reframing.

Deferred features may influence extensible data boundaries, but they must not add
visible complexity or speculative infrastructure to the MVP.

## Implementation guidance

- Prefer small vertical slices that prove capture reliability end to end.
- Build guest capture, local recovery, transcription review, and safe account
  migration before optional guidance or library refinement.
- Model explicit capture states such as `empty`, `recording`, `processing`,
  `editing`, `saved-locally`, `saving`, `saved`, `offline`, and `sync-error`.
- Keep persistence logic separate from visual status so the UI cannot claim a
  save that did not happen.
- Keep original artefacts separate from mutable views in the data model.
- Make recording and authentication flows safe to resume and retry.
- Request microphone permission only after the user selects voice capture and
  explain why it is needed.
- Keep provider-specific transcription, AI, storage, and authentication code
  behind narrow interfaces. An implemented adapter does not authorise live
  activation.
- Avoid speculative abstraction. Introduce a shared abstraction only when it
  protects a product invariant, provider boundary, or repeated behaviour.
- Preserve unrelated user changes. Do not rewrite or delete existing work to
  simplify an implementation.

## Validation expectations

Run the narrowest relevant checks during development and the full available suite
before handing off a meaningful change. Never claim a check passed if it was not
run.

For capture-related changes, test at minimum:

- immediate guest typing and recording without authentication;
- microphone approval and denial;
- explicit stop and a long silence that does not stop recording;
- absence of live transcript, reactive audio visualisation, and distracting
  motion during recording; the approved muted sine wave appears only while
  recording and becomes static under reduced motion;
- transcript appearance only after stop and processing;
- faithful transcription behaviour and uncertainty handling;
- direct editing plus recovery of original audio and transcript;
- reload, browser restart, offline buffering, reconnect, and retry;
- guest-to-account migration through the magic-link flow without loss or
  duplication;
- truthful save-state transitions;
- keyboard, screen-reader, reduced-motion, and mobile-width behaviour; and
- analytics and logs containing no raw story content.

For guidance-related changes, also test:

- **Just listen** remains the default;
- guidance can be entered, skipped, and exited without altering the story;
- previous stories are unavailable until explicitly enabled; and
- every cross-story question names and links its source.

## Documentation and change discipline

- Keep Markdown concise, readable, and valid CommonMark/GitHub-Flavoured
  Markdown.
- Update the PRD only when a product decision actually changes; do not rewrite it
  to match an accidental implementation.
- Document assumptions and unresolved decisions rather than presenting them as
  settled facts.
- When implementation begins, include setup, environment variables, migrations,
  and exact verification commands in the repository documentation.
- Never commit credentials, production story data, generated recordings, local
  databases, or unredacted debug output.
- Summarise completed work with the user-visible outcome, tests run, and any
  remaining risk or open decision.

## Guidance for agents

- Do not consider or worry about backward compatibility.
- Do not think about legacy support or issues.
