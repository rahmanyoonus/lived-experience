# ADR 0007: One-off prompt guidance boundary

- **Status:** Accepted and deployed; synthetic live boundary verified
- **Date:** 21 July 2026
- **Decision owners:** Product owner and implementation team

## Context

The capture canvas needs optional help for a person who does not know where to
start. This help must remain subordinate to **Just listen**, must not turn into
an interview, and must not silently read the private story library. Story text
is sensitive personal data, and the existing OpenAI boundary and monthly spend
cap were designed first for transcription rather than text generation.

## Decision

Rename the deferred guided-question mode to **Interview me** and keep it
disabled. Rename the one-off action to **Guide me with a prompt** and implement
it as a still prompt card that never inserts text, creates a story, changes the
save state, or becomes a persistent capture mode.

Use only a bounded excerpt from the story currently open. If it does not contain
enough meaningful context, ask about one general topic such as work, holidays,
people, places, turning points, practical wisdom, traditions, or a clear memory.
Do not read previous stories in this slice. Any later cross-story version needs
a visible, session-level **Explore past stories** permission and source links.

Generate one short, open-ended question through the OpenAI Responses API using
`gpt-5.6-luna`, explicit structured output, `store: false`, and no tools. Treat
story text as untrusted data rather than instructions. Apply a 12,000-character
context ceiling, a 160-output-token ceiling, a 30-second provider timeout, ten
requests per browser per hour and thirty per day, and one hundred requests per
IP per hour. Prompt and transcription calls share the existing US$49 operating
stop within the US$50 monthly OpenAI ceiling.

Keep story excerpts and generated prompts out of logs, analytics, routine
errors, quota storage, and spend storage. `store: false` is not a Zero Data
Retention claim. As checked on 21 July 2026, OpenAI documents that default abuse
monitoring logs may include prompts and responses for up to 30 days unless the
organisation is approved for and enables Zero Data Retention or Modified Abuse
Monitoring. Re-check data handling, model availability, pricing, and the
accepted US-East Worker placement whenever the endpoint or provider policy
changes.

## Consequences

- A guest can request help without creating an account or an empty story.
- The current story can make the prompt relevant, but other private stories
  remain unavailable.
- Another prompt replaces the first; dismissing it leaves the story unchanged.
- Provider, network, quota, timeout, and invalid-response failures remain
  retryable where appropriate and return content-free product language.
- **Interview me**, read-aloud questions, and cross-story guidance remain later
  work.

## Verification

Test the renamed controls, unchanged **Just listen** state, empty and contextual
prompt requests, replacement and dismissal, loading and retryable errors,
recording/processing exclusion, request and response bounds, same-origin and
signed-browser enforcement, rate and spend limits, provider timeout, structured
output validation, and the absence of story text in operational errors.

Production version `8a43281f-b92c-4b97-bfc6-ebe31bb418c1` was deployed to
`livedexp.atomik.bn` on 21 July 2026. Content-free health and readiness checks
passed. An empty request returned a general memory prompt, and a clearly
fictional bicycle-workshop story returned a question about details from that
story. No personal story content was used for verification.
