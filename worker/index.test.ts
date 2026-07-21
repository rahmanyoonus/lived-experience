import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorker } from "./index";
import {
  handleTranscription,
  TRANSCRIPTION_PROVIDER_TIMEOUT_MS,
  type UpstreamFetch,
} from "./transcription";

const SEGMENT_ID = "115e983e-31c6-4d5f-a80e-d68efcc94bf1";
const SIGNED_BROWSER_COOKIE =
  "aaaaaaaaaaaaaaaaaaaaaa.47061e6a0c34db6a7f53d62e4caf409444b198a2c1fe2afef4a0aad5af7cd375";

type TestWorker = ReturnType<typeof createWorker>;
type IncomingWorkerRequest = Parameters<TestWorker["fetch"]>[0];

function incomingRequest(request: Request): IncomingWorkerRequest {
  // Requests constructed in tests have no Cloudflare edge metadata. The
  // handler does not read `request.cf`, so this is the single test boundary.
  return request as IncomingWorkerRequest;
}

function testEnv(
  apiKey = "",
  rateLimitSecret = "synthetic-rate-limit-secret-32-bytes-long",
): Env {
  return {
    ASSETS: env.ASSETS,
    OPENAI_API_KEY: apiKey,
    RATE_LIMIT_SECRET: rateLimitSecret,
    RATE_LIMITER: env.RATE_LIMITER,
    SPEND_GATE: env.SPEND_GATE,
  };
}

interface RecordingUpload {
  readonly audio: Blob;
  readonly audioByteSize: string;
  readonly audioSha256: string;
  readonly chunkCount: string;
  readonly chunkIndex: string;
  readonly chunkStartMs: string;
  readonly durationMs: string;
  readonly language: string;
  readonly segmentId: string;
}

function recordingForm(
  overrides: {
    readonly audio?: Blob;
    readonly audioByteSize?: string;
    readonly audioSha256?: string;
    readonly chunkCount?: string;
    readonly chunkIndex?: string;
    readonly chunkStartMs?: string;
    readonly durationMs?: string;
    readonly language?: string;
    readonly segmentId?: string;
  } = {},
): RecordingUpload {
  const audio =
    overrides.audio ?? new Blob(["synthetic-audio"], { type: "audio/webm" });
  return {
    audio,
    audioByteSize: overrides.audioByteSize ?? String(audio.size),
    audioSha256:
      overrides.audioSha256 ??
      "ef746a1a59afecba50d3ce36e3506ee52784236e91034569ccb54f73fbc3c632",
    chunkCount: overrides.chunkCount ?? "1",
    chunkIndex: overrides.chunkIndex ?? "1",
    chunkStartMs: overrides.chunkStartMs ?? "0",
    durationMs: overrides.durationMs ?? "2400",
    language: overrides.language ?? "en",
    segmentId: overrides.segmentId ?? crypto.randomUUID(),
  };
}

function transcriptionRequest(
  upload = recordingForm(),
  headers?: HeadersInit,
): IncomingWorkerRequest {
  const requestHeaders = new Headers({
    "CF-Connecting-IP": "192.0.2.10",
    Cookie: `__Host-le_rl_browser=${SIGNED_BROWSER_COOKIE}`,
    "Content-Type": upload.audio.type,
    "X-LE-Audio-Bytes": upload.audioByteSize,
    "X-LE-Audio-Sha256": upload.audioSha256,
    "X-LE-Language": upload.language,
    "X-LE-Part-Count": upload.chunkCount,
    "X-LE-Part-Duration-Ms": upload.durationMs,
    "X-LE-Part-Index": upload.chunkIndex,
    "X-LE-Part-Start-Ms": upload.chunkStartMs,
    "X-LE-Segment-Id": upload.segmentId,
  });
  new Headers(headers).forEach((value, name) => {
    requestHeaders.set(name, value);
  });
  return incomingRequest(
    new Request("https://example.test/api/transcriptions", {
      method: "POST",
      headers: requestHeaders,
      body: upload.audio,
    }),
  );
}

function guidanceRequest(
  body: Record<string, unknown> = {},
  headers?: HeadersInit,
): IncomingWorkerRequest {
  const requestHeaders = new Headers({
    "CF-Connecting-IP": "192.0.2.10",
    Cookie: `__Host-le_rl_browser=${SIGNED_BROWSER_COOKIE}`,
    "Content-Type": "application/json",
    Origin: "https://example.test",
    "Sec-Fetch-Site": "same-origin",
  });
  new Headers(headers).forEach((value, name) => {
    requestHeaders.set(name, value);
  });
  return incomingRequest(
    new Request("https://example.test/api/prompts", {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        storyExcerpt: "A fictional memory of opening a bicycle workshop before sunrise.",
        previousPrompt: null,
        ...body,
      }),
    }),
  );
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json();
}

function transcriptionResponse(
  overrides: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      text: "I, um, kept the blue notebook. Then I paused.",
      logprobs: [
        {
          token: "I, um, kept the blue notebook.",
          bytes: [73],
          logprob: -0.2,
        },
        {
          token: " Then I paused.",
          bytes: [32, 84],
          logprob: -1.2,
        },
      ],
      usage: {
        type: "tokens",
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
      },
      ...overrides,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function guidanceResponse(
  prompt = "What did the fictional workshop sound like before sunrise?",
): Response {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({ prompt }),
            },
          ],
        },
      ],
      usage: {
        input_tokens: 120,
        output_tokens: 18,
        total_tokens: 138,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("Lived Experience Worker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reports whether transcription is configured without exposing a secret", async () => {
    const worker = createWorker();
    const request = incomingRequest(
      new Request("https://example.test/api/health"),
    );

    const unconfigured = await worker.fetch(request, testEnv());
    expect(unconfigured.status).toBe(200);
    await expect(responseJson(unconfigured)).resolves.toEqual({
      status: "ok",
      transcription: "unconfigured",
    });

    const configured = await worker.fetch(
      incomingRequest(new Request("https://example.test/api/health")),
      testEnv("sk-synthetic-health-check"),
    );
    const body = await responseJson(configured);
    expect(body).toEqual({ status: "ok", transcription: "configured" });
    expect(JSON.stringify(body)).not.toContain("sk-synthetic-health-check");
    expect(configured.headers.get("Cache-Control")).toBe("no-store");

    const missingGuardSecret = await worker.fetch(
      incomingRequest(new Request("https://example.test/api/health")),
      testEnv("sk-synthetic-health-check", ""),
    );
    await expect(responseJson(missingGuardSecret)).resolves.toEqual({
      status: "ok",
      transcription: "unconfigured",
    });
  });

  it("reports provider readiness without exposing credentials or story content", async () => {
    const readyProbe = vi.fn().mockResolvedValue(true);
    const worker = createWorker({ providerReadinessProbe: readyProbe });
    const response = await worker.fetch(
      incomingRequest(new Request("https://example.test/api/readiness")),
      testEnv("sk-synthetic-readiness"),
    );

    expect(response.status).toBe(200);
    const body = await responseJson(response);
    expect(body).toEqual({
      status: "ready",
      transcription: "ready",
    });
    expect(readyProbe).toHaveBeenCalledOnce();
    expect(JSON.stringify(body)).not.toContain(
      "sk-synthetic-readiness",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const degraded = createWorker({
      providerReadinessProbe: vi.fn().mockResolvedValue(false),
    });
    const unavailable = await degraded.fetch(
      incomingRequest(new Request("https://example.test/api/readiness")),
      testEnv("sk-synthetic-readiness"),
    );
    expect(unavailable.status).toBe(503);
    await expect(responseJson(unavailable)).resolves.toEqual({
      status: "degraded",
      transcription: "unavailable",
    });
  });

  it("generates one bounded current-story prompt without storing provider state", async () => {
    const upstreamFetch = vi.fn<UpstreamFetch>(() =>
      Promise.resolve(guidanceResponse()),
    );
    const reservationId = crypto.randomUUID();
    const guidanceSpendReconcile = vi.fn(() => Promise.resolve());
    const worker = createWorker({
      upstreamFetch,
      guidanceRateLimitEnforcer: () =>
        Promise.resolve({ allowed: true }),
      guidanceSpendReserve: () =>
        Promise.resolve({ allowed: true, reservationId }),
      guidanceSpendReconcile,
    });
    const response = await worker.fetch(
      guidanceRequest(),
      testEnv("sk-synthetic-guidance"),
    );

    expect(response.status).toBe(200);
    await expect(responseJson(response)).resolves.toEqual({
      prompt: "What did the fictional workshop sound like before sunrise?",
      basis: "current",
      provider: "openai",
      model: "gpt-5.6-luna",
    });
    const upstreamInit = upstreamFetch.mock.calls[0]?.[1];
    const upstreamBody = upstreamInit?.body;
    if (typeof upstreamBody !== "string") {
      throw new Error("Expected provider request body to be a string.");
    }
    const providerRequest = JSON.parse(upstreamBody) as {
      model: string;
      store: boolean;
      instructions: string;
      input: string;
    };
    expect(providerRequest).toMatchObject({
      model: "gpt-5.6-luna",
      store: false,
    });
    expect(providerRequest.instructions).not.toContain("bicycle workshop");
    expect(providerRequest.input).toContain("bicycle workshop");
    expect(guidanceSpendReconcile).toHaveBeenCalledWith(
      expect.anything(),
      reservationId,
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("uses general topics when current-story context is too thin", async () => {
    const upstreamFetch = vi.fn<UpstreamFetch>(() =>
      Promise.resolve(
        guidanceResponse("What is a holiday memory that still feels vivid?"),
      ),
    );
    const worker = createWorker({
      upstreamFetch,
      guidanceRateLimitEnforcer: () =>
        Promise.resolve({ allowed: true }),
      guidanceSpendReserve: () =>
        Promise.resolve({
          allowed: true,
          reservationId: crypto.randomUUID(),
        }),
      guidanceSpendReconcile: () => Promise.resolve(),
    });
    const response = await worker.fetch(
      guidanceRequest({ storyExcerpt: "A memory." }),
      testEnv("sk-synthetic-guidance"),
    );

    await expect(responseJson(response)).resolves.toMatchObject({
      basis: "general",
      prompt: "What is a holiday memory that still feels vivid?",
    });
    const upstreamBody = upstreamFetch.mock.calls[0]?.[1]?.body;
    if (typeof upstreamBody !== "string") {
      throw new Error("Expected provider request body to be a string.");
    }
    const providerRequest = JSON.parse(upstreamBody) as {
      instructions: string;
      input: string;
    };
    expect(providerRequest.instructions).toContain("general topic");
    expect(providerRequest.input).not.toContain("A memory.");
  });

  it("blocks cross-origin and rate-limited prompt requests before OpenAI", async () => {
    const upstreamFetch = vi.fn<UpstreamFetch>();
    const worker = createWorker({
      upstreamFetch,
      guidanceRateLimitEnforcer: () =>
        Promise.resolve({ allowed: false, retryAfterSeconds: 60 }),
    });
    const crossOrigin = await worker.fetch(
      guidanceRequest({}, {
        Origin: "https://attacker.example",
        "Sec-Fetch-Site": "cross-site",
      }),
      testEnv("sk-synthetic-guidance"),
    );
    expect(crossOrigin.status).toBe(403);

    const limited = await worker.fetch(
      guidanceRequest(),
      testEnv("sk-synthetic-guidance"),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("keeps prompt provider failures content-free", async () => {
    const sensitiveFixture = "A synthetic private story about a brass key.";
    const worker = createWorker({
      upstreamFetch: () => Promise.reject(new Error(sensitiveFixture)),
      guidanceRateLimitEnforcer: () =>
        Promise.resolve({ allowed: true }),
      guidanceSpendReserve: () =>
        Promise.resolve({
          allowed: true,
          reservationId: crypto.randomUUID(),
        }),
      guidanceSpendReconcile: () => Promise.resolve(),
    });
    const response = await worker.fetch(
      guidanceRequest({ storyExcerpt: sensitiveFixture }),
      testEnv("sk-synthetic-guidance"),
    );
    const body = await responseJson(response);
    expect(response.status).toBe(502);
    expect(JSON.stringify(body)).not.toContain(sensitiveFixture);
    expect(body).toMatchObject({ code: "GUIDANCE_PROVIDER_ERROR" });
  });

  it("keeps readiness unavailable when required secrets are missing", async () => {
    const providerReadinessProbe = vi.fn().mockResolvedValue(true);
    const worker = createWorker({ providerReadinessProbe });
    const response = await worker.fetch(
      incomingRequest(new Request("https://example.test/api/readiness")),
      testEnv("", ""),
    );

    expect(response.status).toBe(503);
    expect(providerReadinessProbe).not.toHaveBeenCalled();
  });

  it("establishes a signed HttpOnly browser session before accepting audio", async () => {
    const worker = createWorker();
    const first = await worker.fetch(
      incomingRequest(
        new Request("https://example.test/api/transcription-session", {
          method: "POST",
          headers: {
            Origin: "https://example.test",
            "Sec-Fetch-Site": "same-origin",
          },
        }),
      ),
      testEnv("sk-synthetic"),
    );
    expect(first.status).toBe(204);
    expect(first.headers.get("Set-Cookie")).toMatch(
      /^__Host-le_rl_browser=[A-Za-z0-9_-]{22}\.[0-9a-f]{64}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict$/,
    );

    const upstreamFetch = vi.fn<UpstreamFetch>();
    const guardedWorker = createWorker({ upstreamFetch });
    const withoutSession = transcriptionRequest();
    withoutSession.headers.delete("Cookie");
    const rejected = await guardedWorker.fetch(
      withoutSession,
      testEnv("sk-synthetic"),
    );
    expect(rejected.status).toBe(503);
    await expect(responseJson(rejected)).resolves.toMatchObject({
      code: "TRANSCRIPTION_GUARD_UNAVAILABLE",
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("does not parse or forward audio while OpenAI is unconfigured", async () => {
    const upstreamFetch = vi.fn<UpstreamFetch>();
    const worker = createWorker({ upstreamFetch });
    const response = await worker.fetch(
      incomingRequest(
        new Request("https://example.test/api/transcriptions", {
          method: "POST",
        }),
      ),
      testEnv(),
    );

    expect(response.status).toBe(503);
    await expect(responseJson(response)).resolves.toMatchObject({
      code: "TRANSCRIPTION_PROVIDER_UNCONFIGURED",
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "an explicit cross-site browser request",
      headers: new Headers({ "Sec-Fetch-Site": "cross-site" }),
    },
    {
      label: "a browser request with a mismatched origin",
      headers: new Headers({
        Origin: "https://other.example",
        "Sec-Fetch-Site": "same-site",
      }),
    },
    {
      label: "a browser request with an invalid origin",
      headers: new Headers({ Origin: "null" }),
    },
  ])("rejects $label without content", async ({ headers }) => {
    const upstreamFetch = vi.fn<UpstreamFetch>();
    const worker = createWorker({ upstreamFetch });
    const response = await worker.fetch(
      transcriptionRequest(recordingForm(), headers),
      testEnv("sk-synthetic"),
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe("");
    expect(response.headers.get("Content-Type")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("preserves a same-origin browser transcription request", async () => {
    const upstreamFetch: UpstreamFetch = vi.fn(() =>
      Promise.resolve(transcriptionResponse()),
    );
    const worker = createWorker({ upstreamFetch });
    const response = await worker.fetch(
      transcriptionRequest(recordingForm(), {
        Origin: "https://example.test",
        "Sec-Fetch-Site": "same-origin",
      }),
      testEnv("sk-synthetic"),
    );

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "a non-audio body",
      request: () =>
        incomingRequest(
          new Request("https://example.test/api/transcriptions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          }),
        ),
      status: 415,
      code: "TRANSCRIPTION_AUDIO_TYPE_UNSUPPORTED",
    },
    {
      label: "a non-English language",
      request: () =>
        transcriptionRequest(recordingForm({ language: "ms" })),
      status: 422,
      code: "TRANSCRIPTION_LANGUAGE_UNSUPPORTED",
    },
    {
      label: "a zero duration",
      request: () =>
        transcriptionRequest(recordingForm({ durationMs: "0" })),
      status: 422,
      code: "TRANSCRIPTION_CHUNK_INVALID",
    },
    {
      label: "a duration beyond the four-minute part limit",
      request: () =>
        transcriptionRequest(recordingForm({ durationMs: "240001" })),
      status: 422,
      code: "TRANSCRIPTION_CHUNK_INVALID",
    },
    {
      label: "more than sixteen recording parts",
      request: () =>
        transcriptionRequest(recordingForm({ chunkCount: "17" })),
      status: 422,
      code: "TRANSCRIPTION_CHUNK_INVALID",
    },
    {
      label: "a later part with a zero start offset",
      request: () =>
        transcriptionRequest(
          recordingForm({
            chunkCount: "2",
            chunkIndex: "2",
            chunkStartMs: "0",
          }),
        ),
      status: 422,
      code: "TRANSCRIPTION_CHUNK_INVALID",
    },
    {
      label: "a first part with a non-zero start offset",
      request: () =>
        transcriptionRequest(recordingForm({ chunkStartMs: "1" })),
      status: 422,
      code: "TRANSCRIPTION_CHUNK_INVALID",
    },
    {
      label: "an impossible part start offset",
      request: () =>
        transcriptionRequest(
          recordingForm({
            chunkCount: "2",
            chunkIndex: "2",
            chunkStartMs: "240001",
          }),
        ),
      status: 422,
      code: "TRANSCRIPTION_CHUNK_INVALID",
    },
    {
      label: "a recording part ending beyond thirty minutes",
      request: () =>
        transcriptionRequest(
          recordingForm({
            chunkCount: "8",
            chunkIndex: "8",
            chunkStartMs: "1680000",
            durationMs: "120001",
          }),
        ),
      status: 422,
      code: "TRANSCRIPTION_CHUNK_INVALID",
    },
    {
      label: "an Ogg recording",
      request: () =>
        transcriptionRequest(
          recordingForm({
            audio: new Blob(["synthetic-ogg"], { type: "audio/ogg" }),
          }),
        ),
      status: 415,
      code: "TRANSCRIPTION_AUDIO_TYPE_UNSUPPORTED",
    },
    {
      label: "an oversized raw audio body declared by metadata",
      request: () =>
        transcriptionRequest(
          recordingForm({ audioByteSize: "20000001" }),
        ),
      status: 413,
      code: "TRANSCRIPTION_AUDIO_TOO_LARGE",
    },
    {
      label: "a conflicting transport content length",
      request: () =>
        transcriptionRequest(recordingForm(), { "Content-Length": "1" }),
      status: 400,
      code: "TRANSCRIPTION_CONTENT_LENGTH_INVALID",
    },
  ])("rejects $label before calling OpenAI", async ({ request, status, code }) => {
    const upstreamFetch = vi.fn<UpstreamFetch>();
    const worker = createWorker({ upstreamFetch });
    const response = await worker.fetch(request(), testEnv("sk-synthetic"));

    expect(response.status).toBe(status);
    await expect(responseJson(response)).resolves.toMatchObject({ code });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      reason: "attempt-limit" as const,
      code: "TRANSCRIPTION_RETRY_LIMIT_REACHED",
    },
    {
      reason: "contract-invalid" as const,
      code: "TRANSCRIPTION_SEGMENT_CONFLICT",
    },
  ])("rejects $reason before reserving spend or calling OpenAI", async ({ reason, code }) => {
    const upstreamFetch = vi.fn<UpstreamFetch>();
    const spendReserve = vi.fn();
    const rateLimitEnforcer = vi.fn(() =>
      Promise.resolve({ allowed: false as const, reason }),
    );
    const worker = createWorker({
      upstreamFetch,
      rateLimitEnforcer,
      spendReserve,
    });
    const response = await worker.fetch(
      transcriptionRequest(recordingForm({ segmentId: SEGMENT_ID })),
      testEnv("sk-synthetic"),
    );

    expect(response.status).toBe(409);
    await expect(responseJson(response)).resolves.toMatchObject({ code });
    expect(rateLimitEnforcer).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        segmentId: SEGMENT_ID,
        chunkIndex: 1,
        chunkCount: 1,
        chunkStartMs: 0,
        durationMs: 2_400,
        audioSha256:
          "ef746a1a59afecba50d3ce36e3506ee52784236e91034569ccb54f73fbc3c632",
      },
      2,
    );
    expect(spendReserve).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("returns a content-free error when OpenAI fails", async () => {
    const consoleSpies = [
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
    ];
    const upstreamFetch: UpstreamFetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { message: "Synthetic private story text must not escape." },
          }),
          { status: 500 },
        ),
      ),
    );
    const worker = createWorker({
      upstreamFetch,
      rateLimitEnforcer: () => Promise.resolve({ allowed: true }),
    });
    const response = await worker.fetch(
      transcriptionRequest(),
      testEnv("sk-synthetic"),
    );

    expect(response.status).toBe(502);
    const body = await responseJson(response);
    expect(body).toEqual({
      code: "TRANSCRIPTION_PROVIDER_ERROR",
      message:
        "The transcript could not be prepared yet. Your recording remains saved on this device.",
    });
    expect(JSON.stringify(body)).not.toContain("private story");
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it.each([
    [401, "TRANSCRIPTION_PROVIDER_AUTH_FAILED"],
    [403, "TRANSCRIPTION_PROVIDER_ACCESS_DENIED"],
  ])("distinguishes an OpenAI %i without exposing its response", async (status, code) => {
    const upstreamFetch: UpstreamFetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { message: "Synthetic provider detail must not escape." },
          }),
          { status },
        ),
      ),
    );
    const worker = createWorker({
      upstreamFetch,
      rateLimitEnforcer: () => Promise.resolve({ allowed: true }),
    });
    const response = await worker.fetch(
      transcriptionRequest(),
      testEnv("sk-synthetic"),
    );

    expect(response.status).toBe(503);
    const body = await responseJson(response);
    expect(body).toMatchObject({ code });
    expect(JSON.stringify(body)).not.toContain("provider detail");
  });

  it.each([
    {
      label: "a false audio digest",
      upload: recordingForm({ audioSha256: "0".repeat(64) }),
      code: "TRANSCRIPTION_AUDIO_DIGEST_INVALID",
    },
    {
      label: "a false streamed byte count",
      upload: recordingForm({ audioByteSize: "16" }),
      code: "TRANSCRIPTION_AUDIO_SIZE_INVALID",
    },
  ])("rejects $label after streaming without returning provider content", async ({ upload, code }) => {
    const upstreamFetch: UpstreamFetch = vi.fn(
      async (
        _input: Parameters<UpstreamFetch>[0],
        init?: Parameters<UpstreamFetch>[1],
      ) => {
        await new Response(init?.body).arrayBuffer();
        return transcriptionResponse({
          text: "Synthetic provider text that must not be accepted.",
        });
      },
    );
    const worker = createWorker({
      upstreamFetch,
      rateLimitEnforcer: () => Promise.resolve({ allowed: true }),
      spendReserve: () =>
        Promise.resolve({
          allowed: true,
          reservationId: crypto.randomUUID(),
        }),
    });
    const response = await worker.fetch(
      transcriptionRequest(upload),
      testEnv("sk-synthetic"),
    );

    expect(response.status).toBe(400);
    await expect(responseJson(response)).resolves.toMatchObject({ code });
    expect(upstreamFetch).toHaveBeenCalledOnce();
  });

  it("returns faithful text and maps only a strongly low-confidence segment", async () => {
    const upstreamFetch: UpstreamFetch = vi.fn(
      async (
        input: Parameters<UpstreamFetch>[0],
        init?: Parameters<UpstreamFetch>[1],
      ) => {
        expect(input).toBe(
          "https://api.openai.com/v1/audio/transcriptions",
        );
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer sk-synthetic",
        );
        expect(new Headers(init?.headers).get("Content-Type")).toMatch(
          /^multipart\/form-data; boundary=----lived-experience-/,
        );
        const multipart = await new Response(init?.body).text();
        expect(multipart).toContain(
          `filename="${SEGMENT_ID}-1-of-1.webm"`,
        );
        expect(multipart).toContain('name="model"\r\n\r\ngpt-4o-mini-transcribe');
        expect(multipart).toContain('name="language"\r\n\r\nen');
        expect(multipart).toContain('name="response_format"\r\n\r\njson');
        expect(multipart).toContain('name="stream"\r\n\r\nfalse');
        expect(multipart).toContain('name="include[]"\r\n\r\nlogprobs');
        expect(multipart).toContain("synthetic-audio");
        return transcriptionResponse();
      },
    );
    const worker = createWorker({ upstreamFetch });
    const response = await worker.fetch(
      transcriptionRequest(recordingForm({ segmentId: SEGMENT_ID })),
      testEnv("sk-synthetic"),
    );

    expect(response.status).toBe(200);
    const text = "I, um, kept the blue notebook. Then I paused.";
    const uncertainText = "Then I paused.";
    await expect(responseJson(response)).resolves.toEqual({
      text,
      provider: "openai",
      model: "gpt-4o-mini-transcribe",
      language: "en",
      uncertainties: [
        {
          start: text.indexOf(uncertainText),
          end: text.indexOf(uncertainText) + uncertainText.length,
          audioStartMs: 0,
          audioEndMs: 2_400,
          confidence: Math.exp(-1.2),
        },
      ],
    });
  });

  it.each([
    { label: "omitted", logprobs: undefined },
    { label: "null", logprobs: null },
  ])("accepts an empty transcript when OpenAI returns $label logprobs", async ({ logprobs }) => {
    const upstreamFetch: UpstreamFetch = vi.fn(() =>
      Promise.resolve(
        transcriptionResponse({
          text: "",
          logprobs,
        }),
      ),
    );
    const worker = createWorker({
      upstreamFetch,
      rateLimitEnforcer: () => Promise.resolve({ allowed: true }),
    });
    const response = await worker.fetch(
      transcriptionRequest(),
      testEnv("sk-synthetic"),
    );

    expect(response.status).toBe(200);
    await expect(responseJson(response)).resolves.toEqual({
      text: "",
      provider: "openai",
      model: "gpt-4o-mini-transcribe",
      language: "en",
      uncertainties: [],
    });
  });

  it.each([
    { label: "omitted", logprobs: undefined },
    { label: "null", logprobs: null },
  ])("rejects a non-empty transcript when OpenAI returns $label logprobs", async ({ logprobs }) => {
    const upstreamFetch: UpstreamFetch = vi.fn(() =>
      Promise.resolve(
        transcriptionResponse({
          text: "A synthetic memory.",
          logprobs,
        }),
      ),
    );
    const worker = createWorker({
      upstreamFetch,
      rateLimitEnforcer: () => Promise.resolve({ allowed: true }),
    });
    const response = await worker.fetch(
      transcriptionRequest(),
      testEnv("sk-synthetic"),
    );

    expect(response.status).toBe(502);
    await expect(responseJson(response)).resolves.toMatchObject({
      code: "TRANSCRIPTION_PROVIDER_RESPONSE_INVALID",
    });
  });

  it("falls back to whole-part review when low confidence cannot be mapped exactly", async () => {
    const upstreamFetch: UpstreamFetch = vi.fn(() =>
      Promise.resolve(
        transcriptionResponse({
          text: "I paused beside the fictional bridge.",
          logprobs: [
            {
              token: "I stopped beside the fictional bridge.",
              bytes: [73],
              logprob: -1.4,
            },
          ],
        }),
      ),
    );
    const worker = createWorker({
      upstreamFetch,
      rateLimitEnforcer: () => Promise.resolve({ allowed: true }),
    });
    const response = await worker.fetch(
      transcriptionRequest(),
      testEnv("sk-synthetic"),
    );

    expect(response.status).toBe(200);
    await expect(responseJson(response)).resolves.toMatchObject({
      text: "I paused beside the fictional bridge.",
      uncertainties: [
        {
          start: 0,
          end: "I paused beside the fictional bridge.".length,
          audioStartMs: 0,
          audioEndMs: 2_400,
          confidence: Math.exp(-1.4),
        },
      ],
    });
  });

  it("merges adjacent low-confidence tokens into one review range", async () => {
    const text = "I paused, um, beside the bridge.";
    const upstreamFetch: UpstreamFetch = vi.fn(() =>
      Promise.resolve(
        transcriptionResponse({
          text,
          logprobs: [
            { token: "I paused", bytes: [73], logprob: -0.2 },
            { token: ", um", bytes: [44], logprob: -1.2 },
            { token: ", beside", bytes: [44], logprob: -1.5 },
            { token: " the bridge.", bytes: [32], logprob: -0.1 },
          ],
        }),
      ),
    );
    const worker = createWorker({
      upstreamFetch,
      rateLimitEnforcer: () => Promise.resolve({ allowed: true }),
    });
    const response = await worker.fetch(
      transcriptionRequest(),
      testEnv("sk-synthetic"),
    );

    expect(response.status).toBe(200);
    await expect(responseJson(response)).resolves.toMatchObject({
      uncertainties: [
        {
          start: text.indexOf(", um"),
          end: text.indexOf(" the bridge."),
          audioStartMs: 0,
          audioEndMs: 2_400,
          confidence: Math.exp(-1.5),
        },
      ],
    });
  });

  it("does not call OpenAI after the monthly operating budget is reserved", async () => {
    const upstreamFetch = vi.fn<UpstreamFetch>();
    const spendReserve = vi.fn(() =>
      Promise.resolve({
        allowed: false as const,
        retryAfterSeconds: 12_345,
      }),
    );
    const worker = createWorker({
      upstreamFetch,
      rateLimitEnforcer: () => Promise.resolve({ allowed: true }),
      spendReserve,
    });
    const response = await worker.fetch(
      transcriptionRequest(),
      testEnv("sk-synthetic"),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("12345");
    await expect(responseJson(response)).resolves.toMatchObject({
      code: "TRANSCRIPTION_BUDGET_REACHED",
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(spendReserve).toHaveBeenCalledWith(
      expect.anything(),
      4 * 60 * 1_000,
    );
  });

  it("releases an attempt that never reached the provider", async () => {
    const release = vi.fn(() => Promise.resolve());
    const upstreamFetch = vi.fn<UpstreamFetch>();
    const response = await handleTranscription(
      transcriptionRequest(),
      "sk-synthetic",
      upstreamFetch,
      () => Promise.resolve({ response: null, release }),
      {
        reserve: () =>
          Promise.resolve({
            allowed: false,
            retryAfterSeconds: 60,
          }),
        reconcile: () => Promise.resolve(),
      },
    );

    expect(response.status).toBe(503);
    expect(release).toHaveBeenCalledOnce();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("retains an attempt once the provider call has begun", async () => {
    const release = vi.fn(() => Promise.resolve());
    const response = await handleTranscription(
      transcriptionRequest(),
      "sk-synthetic",
      vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))),
      () => Promise.resolve({ response: null, release }),
      {
        reserve: () =>
          Promise.resolve({
            allowed: true,
            reservationId: crypto.randomUUID(),
          }),
        reconcile: () => Promise.resolve(),
      },
    );

    expect(response.status).toBe(502);
    expect(release).not.toHaveBeenCalled();
  });

  it("reconciles a successful provider call using returned usage", async () => {
    const reservationId = crypto.randomUUID();
    const responseBody = {
      text: "A synthetic memory.",
      logprobs: [
        {
          token: "A synthetic memory.",
          bytes: [65],
          logprob: -0.1,
        },
      ],
      usage: {
        type: "tokens",
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
      },
    };
    const spendReconcile = vi.fn(() => Promise.resolve());
    const worker = createWorker({
      upstreamFetch: vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(responseBody), {
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
      rateLimitEnforcer: () => Promise.resolve({ allowed: true }),
      spendReserve: () =>
        Promise.resolve({ allowed: true, reservationId }),
      spendReconcile,
    });
    const response = await worker.fetch(
      transcriptionRequest(),
      testEnv("sk-synthetic"),
    );

    expect(response.status).toBe(200);
    expect(spendReconcile).toHaveBeenCalledWith(
      expect.anything(),
      reservationId,
      responseBody,
    );
  });

  it("stops waiting for OpenAI after ten minutes", async () => {
    expect(TRANSCRIPTION_PROVIDER_TIMEOUT_MS).toBe(10 * 60 * 1_000);
    const upstreamFetch: UpstreamFetch = vi.fn((
      _input: Parameters<UpstreamFetch>[0],
      init?: Parameters<UpstreamFetch>[1],
    ) => {
      const signal = init?.signal;
      if (!signal) {
        return Promise.reject(new Error("Expected a provider timeout signal."));
      }
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("Synthetic provider timeout.")),
          { once: true },
        );
      });
    });
    const worker = createWorker({
      upstreamFetch,
      rateLimitEnforcer: () => Promise.resolve({ allowed: true }),
      spendReserve: () =>
        Promise.resolve({
          allowed: true,
          reservationId: crypto.randomUUID(),
        }),
      spendReconcile: () => Promise.resolve(),
      providerTimeoutMs: 5,
    });
    const response = await worker.fetch(
      transcriptionRequest(),
      testEnv("sk-synthetic"),
    );

    expect(response.status).toBe(504);
    await expect(responseJson(response)).resolves.toMatchObject({
      code: "TRANSCRIPTION_PROVIDER_TIMEOUT",
    });
  });

  it("returns a structured API 404", async () => {
    const worker = createWorker();
    const response = await worker.fetch(
      incomingRequest(new Request("https://example.test/api/missing")),
      testEnv(),
    );

    expect(response.status).toBe(404);
    await expect(responseJson(response)).resolves.toEqual({
      code: "NOT_FOUND",
      message: "Not found.",
    });
  });
});
