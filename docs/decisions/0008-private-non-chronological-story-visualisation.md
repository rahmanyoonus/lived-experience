# ADR 0008: Private non-chronological story visualisation

- **Status:** Accepted and implemented locally
- **Date:** 21 July 2026
- **Decision owners:** Product owner and implementation team

## Context

The reverse-chronological **Your stories** library is dependable for finding and
continuing retained work, but it presents every story as a conventional list
card. The product owner approved a separate **Visualise my stories** option for
rediscovering retained stories through interaction and ambient motion. People
do not necessarily tell their lives chronologically, so a life timeline, video
sequence or inferred relationship map would misrepresent the material.

Story summaries contain sensitive personal information. The visualisation must
remain private, must not become a publishing surface, and must not weaken the
capture, sync or safe story-opening boundaries.

## Decision

Add **Visualise my stories** as an authenticated, optional third surface. Use
only the existing owner-scoped library summary fields: stable story ID, factual
title or fallback, capture date, verbatim excerpt and voice duration. Shuffle
their presentation into a stable, non-chronological arrangement across three
slow horizontal lanes. Do not derive themes, chronology, relationships,
sentiment, importance or a preferred narrative from order or proximity.

Provide explicit pause, resume and shuffle controls. Pause motion when the page
is hidden, when the person touches or focuses the field, and while a story is in
focus. Honour reduced motion with a static editorial arrangement. Decorative
echoes required for continuous movement are not interactive and remain hidden
from assistive technology. Do not autoplay audio.

Reuse the existing story-library loading boundary and safe open-story path so
the current draft is flushed, sync is checked, pending recordings block unsafe
navigation, and cloud adoption remains recoverable. Keep **Your stories** as the
practical reverse-chronological archive.

Implement the first slice with React state and CSS `transform`, `opacity` and
`animation-play-state`. Do not add an animation library until requirements such
as free-form inertial dragging or interruption-safe spring choreography justify
the extra runtime and maintenance boundary.

## Consequences

- A person can rediscover stories without the interface imposing a timeline or
  suggesting that neighbouring stories are related.
- The animated surface remains secondary and unavailable during recording,
  processing or pending-recording recovery.
- No new provider receives story content, and no new content-bearing analytics
  or logs are introduced.
- The feature needs explicit motion, reduced-motion, keyboard, focus,
  forced-colour, mobile-width and safe story-opening verification.
- Any later categorisation, connection graph, generated imagery, free-form
  physics or sharing remains a separate product and privacy decision.

## Verification

Test authenticated-only entry, stable shuffled presentation, pause and resume,
explicit shuffle, focus and touch pausing, reduced motion, loading/error/empty
states, semantic story controls, decorative-clone isolation, story focus,
return-to-capture focus restoration, and opening by stable story ID through the
existing persistence and sync guards. Verify at desktop and mobile widths with
synthetic fictional fixtures only.
