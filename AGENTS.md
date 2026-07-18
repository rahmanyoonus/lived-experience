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

The repository currently contains product documentation only. No production
framework, hosting platform, database, authentication provider, transcription
provider, or AI provider has been selected.

- Do not invent or imply that an undecided technology is already approved.
- When asked to scaffold the application, make the smallest defensible
  architecture choice and document it.
- Record consequential and difficult-to-reverse choices in a short ADR under
  `docs/decisions/`.
- Once build, test, lint, and development commands exist, document their exact
  forms in `README.md` and keep this file current.

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
- Keep **Just listen** as the default. **Guide me** and **Give me a prompt** must
  remain clearly available and optional.
- Keep the screen visually still while recording. Do not show a live transcript,
  moving waveform, animated words, or distracting layout changes.
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
- Offer a non-blocking **Keep this story** action after content exists. Google is
  the only MVP sign-in method.
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
  behind narrow interfaces. Provider selection remains an open decision.
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
- absence of live transcript and moving waveform during recording;
- transcript appearance only after stop and processing;
- faithful transcription behaviour and uncertainty handling;
- direct editing plus recovery of original audio and transcript;
- reload, browser restart, offline buffering, reconnect, and retry;
- guest-to-Google migration without loss or duplication;
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
