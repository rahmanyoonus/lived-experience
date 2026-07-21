# ADR 0002: OpenAI transcription boundary

- **Status:** Accepted; deployment credentials pending
- **Date:** 19 July 2026
- **Decision owners:** Product owner and implementation team

## Context

The first slice needs faithful English transcription after each explicit
recording stop. It also needs honest uncertainty links so a person can return
to the relevant original audio. Story recordings are sensitive personal data,
and the browser must never receive the OpenAI credential.

OpenAI's current endpoint-specific data table states that
`/v1/audio/transcriptions` is not used for training, has no abuse-monitoring
retention, has no application-state retention, and is eligible for Zero Data
Retention. This endpoint-specific statement supersedes the earlier provisional
assumption that transcription content would use the generic 30-day API
retention posture. Zero Data Retention remains deferred rather than required
for this slice; the documented endpoint defaults must be reviewed again if the
provider policy or selected endpoint changes.

`gpt-4o-mini-transcribe` currently has an estimated price of US$0.003 per
minute, half the estimated price of `whisper-1`. It returns token log
probabilities but not word or segment timestamps. The product owner accepted
chunk-level audio review in exchange for the lower hackathon cost.

## Decision

Use OpenAI's `/v1/audio/transcriptions` endpoint through the Cloudflare Worker
with `gpt-4o-mini-transcribe`, English language input, JSON output, token log
probabilities, and no streaming. Do not run a second model over the transcript
and do not silently rewrite provider text.

One explicit user start-to-stop action remains one logical spoken segment of up
to 30 minutes. Underneath that segment, record ordered, standalone media parts
and send them sequentially to OpenAI. Each provider part must be no longer than
four minutes and no larger than 20,000,000 bytes. Never byte-slice a media
container or assume a MediaRecorder timeslice blob is independently playable.
The original ordered parts remain immutable and recoverable locally and, after
authentication, in private cloud storage.

The transcription boundary must:

- establish a same-origin browser session before uploading audio, represented
  by a secret-signed, `HttpOnly`, `Secure`, `SameSite=Strict` cookie;
- calculate a SHA-256 digest in the browser and send each standalone part as a
  raw media body with its declared byte count, digest, and logical coordinates;
- stream the media into the provider multipart body while independently
  counting bytes and calculating SHA-256 with `DigestStream`, completing the
  multipart body only after both values exactly match the declarations;
- accept English WebM, MP4, or M4A audio only;
- reject explicit cross-origin browser uploads before reading audio;
- validate each part's index, count, duration, start offset, and logical
  30-minute boundary;
- preserve the provider text and combine ordered part transcripts with only a
  whitespace boundary;
- mark only low-log-probability tokens whose character offsets map exactly to
  returned text;
- link an uncertain token to its containing audio part and label that scope
  honestly rather than implying word-accurate timing;
- apply one ten-minute deadline to the complete client-side segment workflow,
  with a ten-minute upstream safety timeout on each Worker request;
- return content-free operational errors and never log audio, transcript text,
  provider response bodies, credentials, raw IP addresses, or signed media
  URLs; and
- expose configuration health without exposing a secret.

Request controls are enforced in SQLite-backed Cloudflare Durable Objects:

- three logical segments per rolling hour and ten per rolling day per browser;
- twenty logical segments per rolling hour per IP address;
- idempotent quota reservations keyed to the logical segment so internal parts
  and safe retries do not consume additional segment allowance;
- an immutable per-part contract for its segment, index, count, timeline, and
  audio digest, with at most two provider attempts per part;
- 30-day retention for quota reservations and segment-coordination contracts,
  with alarms that purge expired rows and deallocate empty coordination
  storage; and
- a Worker-side monthly spend gate operating below the approved US$50 ceiling,
  with conservative reservation before every provider call and reconciliation
  from returned token usage when available. Unknown-cost calls keep their
  conservative reservation.

Browser and network identities are stored only as secret-keyed hashes. OpenAI
project budget alerts remain useful operational warnings, but they are not the
hard gate because OpenAI documents project monthly budgets as soft thresholds.

## Consequences

- A maximum 30-minute transcription is estimated at about US$0.09 before any
  retry, compared with about US$0.18 using `whisper-1`.
- The selected model's 2,000-output-token limit is contained by four-minute
  parts, and a failed provider call can be retried without resending the whole
  recording.
- A part receives one initial provider attempt and at most one retry. Rejections
  before the spend gate or provider call release their attempt lease; once the
  provider call begins, the attempt remains consumed even if its result is
  unknown. This deliberately favours a hard cost bound over unlimited retries.
- Uncertainty is exact to a stored audio part, not to the exact spoken word.
  The application must say **Review this part** and must not display invented
  word timestamps.
- Streamed digest verification avoids buffering another complete audio copy in
  the Worker, but the final digest is only known after earlier bytes have been
  forwarded. The multipart body is not completed when validation fails; this
  boundary must not be described as proof that no malformed byte could have
  reached the provider.
- The Worker does not yet independently parse the raw media container to verify
  actual audio duration. It validates the declared part and timeline metadata
  and conservatively reserves the full four-minute part duration for every
  admitted provider call. Server-side media-duration parsing or an approved
  equivalent remains a launch risk.
- OpenAI's Free API usage tier does not support this model, so deployment needs
  project billing or hackathon credits even though Cloudflare and Supabase can
  remain within their free allowances.
- The recording and every completed part remain saved when transcription is
  unconfigured, rate-limited, over budget, timed out, offline, or rejected.

## Deployment checks

Before accepting real story audio:

- use a dedicated OpenAI project and set its visible monthly budget and alerts
  to US$50 while retaining the Worker-side gate;
- set `OPENAI_API_KEY` and the transcription guard secret only through
  Cloudflare's secret store;
- never paste OpenAI, Cloudflare, Supabase, OAuth, or signing secrets into chat;
- verify the current endpoint data-control table and model price have not
  changed; and
- run a synthetic-audio smoke test through the deployed Worker without placing
  personal story content in fixtures or logs.

## References

- [OpenAI transcription pricing](https://developers.openai.com/api/docs/pricing#transcription-models)
- [`gpt-4o-mini-transcribe` model](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe)
- [OpenAI speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text)
- [OpenAI transcription API reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)
- [OpenAI data controls by endpoint](https://developers.openai.com/api/docs/guides/your-data#default-usage-policies-by-endpoint)
- [OpenAI project budget behaviour](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform)
