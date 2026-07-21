import { jsonResponse } from "./http";
import {
  establishTranscriptionBrowserSession,
  enforceTranscriptionRateLimits,
  type TranscriptionRateLimitInput,
  type TranscriptionRateLimitResult,
} from "./rate-limit";
import { OPENAI_TRANSCRIPTION_PROVIDER_POLICY } from "./provider-policy";
import {
  reconcileTranscriptionSpend,
  reserveTranscriptionSpend,
} from "./spend-gate";
import { handleTranscription, type UpstreamFetch } from "./transcription";

export { TranscriptionRateLimiter } from "./rate-limit";
export { TranscriptionSpendGate } from "./spend-gate";

type RateLimitEnforcer = (
  request: Request,
  env: Env,
  input: TranscriptionRateLimitInput,
  maxAttempts: 2 | 3,
) => Promise<TranscriptionRateLimitResult>;

interface WorkerDependencies {
  readonly upstreamFetch?: UpstreamFetch;
  readonly rateLimitEnforcer?: RateLimitEnforcer;
  readonly spendReserve?: typeof reserveTranscriptionSpend;
  readonly spendReconcile?: typeof reconcileTranscriptionSpend;
  readonly providerTimeoutMs?: number;
  readonly providerReadinessProbe?: (
    apiKey: string,
    upstreamFetch: UpstreamFetch,
  ) => Promise<boolean>;
}

const TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const READINESS_TIMEOUT_MS = 5_000;
const READY_CACHE_SECONDS = 5 * 60;
const DEGRADED_CACHE_SECONDS = 30;

async function probeTranscriptionProvider(
  apiKey: string,
  upstreamFetch: UpstreamFetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), READINESS_TIMEOUT_MS);
  try {
    const response = await upstreamFetch(
      `https://api.openai.com/v1/models/${TRANSCRIPTION_MODEL}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      },
    );
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function isCrossOriginBrowserPost(request: Request, url: URL): boolean {
  const fetchSite = request.headers
    .get("Sec-Fetch-Site")
    ?.trim()
    .toLowerCase();
  if (fetchSite === "cross-site") {
    return true;
  }

  const origin = request.headers.get("Origin");
  if (origin === null) {
    return false;
  }

  try {
    return new URL(origin).origin !== url.origin;
  } catch {
    return true;
  }
}

function forbiddenResponse(): Response {
  return new Response(null, {
    status: 403,
    headers: { "Cache-Control": "no-store" },
  });
}

function withBrowserCookie(
  response: Response,
  setCookie: string | undefined,
): Response {
  if (!setCookie) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", setCookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function rateLimitedResponse(
  result: TranscriptionRateLimitResult,
): Response {
  return jsonResponse(
    {
      code: "TRANSCRIPTION_RATE_LIMITED",
      message:
        "The transcription limit has been reached for now. Your recording remains saved on this device.",
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(result.retryAfterSeconds ?? 1),
      },
    },
  );
}

function guardUnavailableResponse(): Response {
  return jsonResponse(
    {
      code: "TRANSCRIPTION_GUARD_UNAVAILABLE",
      message:
        "Transcription is not available yet. Your recording remains saved on this device.",
    },
    { status: 503 },
  );
}

function partAttemptRejectedResponse(
  reason: "attempt-limit" | "contract-invalid",
): Response {
  if (reason === "attempt-limit") {
    return jsonResponse(
      {
        code: "TRANSCRIPTION_RETRY_LIMIT_REACHED",
        message:
          "This recording part has reached its retry limit. The original recording remains saved on this device.",
      },
      { status: 409 },
    );
  }
  return jsonResponse(
    {
      code: "TRANSCRIPTION_SEGMENT_CONFLICT",
      message:
        "This recording part no longer matches the saved segment. The original recording remains saved on this device.",
    },
    { status: 409 },
  );
}

export function createWorker(dependencies: WorkerDependencies = {}) {
  const upstreamFetch: UpstreamFetch =
    dependencies.upstreamFetch ??
    ((input, init) => fetch(input, init));
  const rateLimitEnforcer =
    dependencies.rateLimitEnforcer ?? enforceTranscriptionRateLimits;
  const spendReserve =
    dependencies.spendReserve ?? reserveTranscriptionSpend;
  const spendReconcile =
    dependencies.spendReconcile ?? reconcileTranscriptionSpend;
  const providerTimeoutMs = dependencies.providerTimeoutMs;
  const providerReadinessProbe =
    dependencies.providerReadinessProbe ?? probeTranscriptionProvider;

  return {
    async fetch(request, env): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname === "/api/health") {
        if (request.method !== "GET") {
          return jsonResponse(
            { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." },
            { status: 405, headers: { Allow: "GET" } },
          );
        }
        const transcriptionConfigured = Boolean(
          env.OPENAI_API_KEY?.trim() &&
            env.RATE_LIMIT_SECRET?.trim().length >= 32,
        );
        return jsonResponse({
          status: "ok",
          transcription: transcriptionConfigured
            ? "configured"
            : "unconfigured",
        });
      }

      if (url.pathname === "/api/readiness") {
        if (request.method !== "GET") {
          return jsonResponse(
            { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." },
            { status: 405, headers: { Allow: "GET" } },
          );
        }
        const apiKey = env.OPENAI_API_KEY?.trim();
        const guardConfigured =
          env.RATE_LIMIT_SECRET?.trim().length >= 32;
        if (!apiKey || !guardConfigured) {
          return jsonResponse(
            { status: "degraded", transcription: "unavailable" },
            { status: 503 },
          );
        }

        const cacheKey = new Request(
          `${url.origin}/api/readiness/provider-cache`,
        );
        const platformCache = (caches as CacheStorage & { default: Cache })
          .default;
        let providerReady: boolean;
        const usePlatformCache = dependencies.providerReadinessProbe === undefined;
        const cached = usePlatformCache
          ? await platformCache.match(cacheKey)
          : undefined;
        if (cached) {
          const cachedBody = await cached.json<{ ready?: unknown }>();
          providerReady = cachedBody.ready === true;
        } else {
          providerReady = await providerReadinessProbe(apiKey, upstreamFetch);
          if (usePlatformCache) {
            await platformCache.put(
              cacheKey,
              jsonResponse(
                { ready: providerReady },
                {
                  headers: {
                    "Cache-Control": `public, max-age=${providerReady ? READY_CACHE_SECONDS : DEGRADED_CACHE_SECONDS}`,
                  },
                },
              ),
            );
          }
        }

        return jsonResponse(
          {
            status: providerReady ? "ready" : "degraded",
            transcription: providerReady ? "ready" : "unavailable",
          },
          providerReady ? undefined : { status: 503 },
        );
      }

      if (url.pathname === "/api/transcriptions") {
        if (request.method !== "POST") {
          return jsonResponse(
            { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." },
            { status: 405, headers: { Allow: "POST" } },
          );
        }
        if (isCrossOriginBrowserPost(request, url)) {
          return forbiddenResponse();
        }

        // Keep an intentionally unconfigured provider inert without consuming
        // a user's transcription allowance.
        if (!env.OPENAI_API_KEY?.trim()) {
          return handleTranscription(request, env.OPENAI_API_KEY, upstreamFetch);
        }

        let rateLimitResult: TranscriptionRateLimitResult | undefined;
        const response = await handleTranscription(
          request,
          env.OPENAI_API_KEY,
          upstreamFetch,
          async (input) => {
            try {
              rateLimitResult = await rateLimitEnforcer(
                request,
                env,
                input,
                OPENAI_TRANSCRIPTION_PROVIDER_POLICY.maxPartAttempts,
              );
            } catch {
              return { response: guardUnavailableResponse() };
            }
            if (!rateLimitResult.allowed) {
              return {
                response: rateLimitResult.reason
                  ? partAttemptRejectedResponse(rateLimitResult.reason)
                  : rateLimitedResponse(rateLimitResult),
              };
            }
            const attemptLease = rateLimitResult.attemptLease;
            return {
              response: null,
              ...(attemptLease
                ? {
                    release: () =>
                      env.RATE_LIMITER.getByName(
                        `segment:${attemptLease.segmentKey}`,
                      ).releasePartAttempt(
                        attemptLease.segmentKey,
                        attemptLease.leaseId,
                      ),
                  }
                : {}),
            };
          },
          {
            reserve: ({ durationMs }) => spendReserve(env, durationMs),
            reconcile: (reservationId, body) =>
              spendReconcile(env, reservationId, body),
          },
          providerTimeoutMs,
        );
        return withBrowserCookie(response, rateLimitResult?.setCookie);
      }

      if (url.pathname === "/api/transcription-session") {
        if (request.method !== "POST") {
          return jsonResponse(
            { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." },
            { status: 405, headers: { Allow: "POST" } },
          );
        }
        if (isCrossOriginBrowserPost(request, url)) {
          return forbiddenResponse();
        }
        try {
          const session = await establishTranscriptionBrowserSession(
            request,
            env,
          );
          return withBrowserCookie(
            new Response(null, {
              status: 204,
              headers: { "Cache-Control": "no-store" },
            }),
            session.setCookie,
          );
        } catch {
          return guardUnavailableResponse();
        }
      }

      if (url.pathname.startsWith("/api/")) {
        return jsonResponse(
          { code: "NOT_FOUND", message: "Not found." },
          { status: 404 },
        );
      }

      return env.ASSETS.fetch(request);
    },
  } satisfies ExportedHandler<Env>;
}

export default createWorker();
