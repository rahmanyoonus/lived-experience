# ADR 0004: Cloudflare API placement

- **Status:** Accepted
- **Date:** 20 July 2026
- **Decision owners:** Product owner and implementation team

## Context

The first Atomik Cloudflare deployment served the application, health route,
and same-origin browser session correctly. The configured OpenAI key and the
selected `gpt-4o-mini-transcribe` model also accepted a synthetic WebM when
called directly from the development machine. The identical synthetic request
sent from the Worker's default execution location received HTTP 403 from
OpenAI.

OpenAI documents HTTP 403 as an unsupported country, region, or territory
response. Cloudflare runs a Worker near the incoming request by default and
supports an explicit placement region for Workers that call one primary
external service.

Routing private audio through a fixed region is a consequential processing-
geography decision. The product owner explicitly approved US-East placement
for this hackathon version.

## Decision

Set the Cloudflare Worker placement region to `aws:us-east-1` in
`wrangler.jsonc`.

The placement applies to Worker `fetch` execution, including request guards,
streaming audio verification, and forwarding accepted audio to OpenAI. Static
Assets remain served from Cloudflare's location nearest the user. Supabase
storage location and OpenAI's own provider-side processing geography are
separate boundaries and are not changed or implied by this decision.

Keep the original same-origin, rate-limit, retry, spend, digest, and
content-free error controls unchanged. Do not log audio, transcript text,
credentials, or provider response bodies while verifying placement.

## Consequences

- API requests from Brunei and other locations gain an additional round trip
  to US-East before Worker execution.
- Post-recording transcription is not latency-critical during active capture,
  so predictable provider access takes priority for the hackathon slice.
- The public static application remains globally edge-served.
- This decision must be reviewed before production expansion or a regional
  privacy commitment.

## Verification

On 20 July 2026, the deployed homepage, health route, and
transcription-session route remained available after placement. A synthetic
WebM sent through the public `/api/transcriptions` route received a successful
OpenAI response from `gpt-4o-mini-transcribe`. The provider boundary is accepted
as live for the hackathon slice.

This verifies reachability and integration, not real-speech transcription
quality. The direct-provider comparison remains diagnostic evidence only and
is not an application path.

## References

- [Cloudflare Worker placement](https://developers.cloudflare.com/workers/configuration/placement/)
- [OpenAI API errors](https://developers.openai.com/api/docs/guides/error-codes#api-errors)
