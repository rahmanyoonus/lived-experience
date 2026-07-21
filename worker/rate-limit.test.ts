import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  BROWSER_RATE_LIMIT_POLICY,
  createSignedBrowserCookieValue,
  establishTranscriptionBrowserSession,
  enforceGuidanceRateLimits,
  enforceTranscriptionRateLimits,
  evaluateRateLimitReservation,
  GUIDANCE_BROWSER_RATE_LIMIT_POLICY,
} from "./rate-limit";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const RATE_LIMIT_SECRET = "synthetic-rate-limit-secret-32-bytes-long";

async function requestFor(
  ipAddress: string,
  browserId?: string,
): Promise<Request> {
  const headers = new Headers({ "CF-Connecting-IP": ipAddress });
  if (browserId) {
    const signed = await createSignedBrowserCookieValue(
      RATE_LIMIT_SECRET,
      browserId,
    );
    headers.set("Cookie", `__Host-le_rl_browser=${signed}`);
  }
  return new Request("https://example.test/api/transcriptions", {
    headers,
  });
}

function uniqueBrowserId(sequence: number): string {
  return sequence.toString(36).padStart(22, "a");
}

function testEnv(): Env {
  return {
    ASSETS: env.ASSETS,
    OPENAI_API_KEY: "sk-synthetic",
    RATE_LIMIT_SECRET,
    RATE_LIMITER: env.RATE_LIMITER,
    SPEND_GATE: env.SPEND_GATE,
  };
}

function rateLimitInput(
  segmentId = crypto.randomUUID(),
  overrides: Partial<{
    chunkIndex: number;
    chunkCount: number;
    chunkStartMs: number;
    durationMs: number;
    audioSha256: string;
  }> = {},
) {
  return {
    segmentId,
    chunkIndex: overrides.chunkIndex ?? 1,
    chunkCount: overrides.chunkCount ?? 1,
    chunkStartMs: overrides.chunkStartMs ?? 0,
    durationMs: overrides.durationMs ?? 120_000,
    audioSha256: overrides.audioSha256 ?? "9".repeat(64),
  };
}

describe("rolling transcription limits", () => {
  it("allows three browser segments per rolling hour and expires at the boundary", () => {
    const timestamps = [0, 10 * 60_000, 20 * 60_000];
    const blocked = evaluateRateLimitReservation(
      timestamps,
      30 * 60_000,
      BROWSER_RATE_LIMIT_POLICY,
    );
    expect(blocked).toMatchObject({
      allowed: false,
      retryAfterSeconds: 30 * 60,
    });

    const boundary = evaluateRateLimitReservation(
      timestamps,
      HOUR_MS,
      BROWSER_RATE_LIMIT_POLICY,
    );
    expect(boundary.allowed).toBe(true);
    expect(boundary.retainedTimestamps).toEqual([
      0,
      10 * 60_000,
      20 * 60_000,
      HOUR_MS,
    ]);
  });

  it("allows ten browser segments per rolling day and expires at the boundary", () => {
    const timestamps = Array.from(
      { length: 10 },
      (_, index) => index * 2 * HOUR_MS,
    );
    const blocked = evaluateRateLimitReservation(
      timestamps,
      20 * HOUR_MS,
      BROWSER_RATE_LIMIT_POLICY,
    );
    expect(blocked).toMatchObject({
      allowed: false,
      retryAfterSeconds: 4 * 60 * 60,
    });

    const boundary = evaluateRateLimitReservation(
      timestamps,
      DAY_MS,
      BROWSER_RATE_LIMIT_POLICY,
    );
    expect(boundary.allowed).toBe(true);
  });
});

describe("rolling guidance limits", () => {
  it("allows thirty prompts per rolling hour and expires at the boundary", () => {
    const timestamps = Array.from(
      { length: 30 },
      (_, index) => index * 2 * 60_000,
    );
    const blocked = evaluateRateLimitReservation(
      timestamps,
      HOUR_MS - 1,
      GUIDANCE_BROWSER_RATE_LIMIT_POLICY,
    );
    expect(blocked).toMatchObject({
      allowed: false,
      retryAfterSeconds: 1,
    });

    const boundary = evaluateRateLimitReservation(
      timestamps,
      HOUR_MS,
      GUIDANCE_BROWSER_RATE_LIMIT_POLICY,
    );
    expect(boundary.allowed).toBe(true);
  });

  it("allows ninety prompts per rolling day and expires at the boundary", () => {
    const timestamps = Array.from(
      { length: 90 },
      (_, index) => index * 16 * 60_000,
    );
    const blocked = evaluateRateLimitReservation(
      timestamps,
      DAY_MS - 1,
      GUIDANCE_BROWSER_RATE_LIMIT_POLICY,
    );
    expect(blocked).toMatchObject({
      allowed: false,
      retryAfterSeconds: 1,
    });

    const boundary = evaluateRateLimitReservation(
      timestamps,
      DAY_MS,
      GUIDANCE_BROWSER_RATE_LIMIT_POLICY,
    );
    expect(boundary.allowed).toBe(true);
  });
});

describe("transcription rate-limit Durable Objects", () => {
  it("serialises concurrent browser reservations and returns a secure identifier cookie", async () => {
    const browserId = uniqueBrowserId(Math.floor(Math.random() * 1_000_000));
    const ipAddress = `192.0.2.${Math.floor(Math.random() * 100) + 1}`;
    const request = await requestFor(ipAddress, browserId);
    const decisions = await Promise.all(
      Array.from({ length: 4 }, () =>
        enforceTranscriptionRateLimits(
          request,
          testEnv(),
          rateLimitInput(),
          2,
        ),
      ),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(1);

    const cookieDecision = await establishTranscriptionBrowserSession(
      await requestFor(`198.51.100.${Math.floor(Math.random() * 100) + 1}`),
      testEnv(),
    );
    expect(cookieDecision.setCookie).toMatch(
      /^__Host-le_rl_browser=[A-Za-z0-9_-]{22}\.[0-9a-f]{64}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict$/,
    );
  });

  it("does not consume another allowance for later parts or a permitted retry", async () => {
    const browserId = uniqueBrowserId(Math.floor(Math.random() * 1_000_000));
    const ipAddress = `203.0.113.${Math.floor(Math.random() * 100) + 1}`;
    const request = await requestFor(ipAddress, browserId);
    const segmentId = crypto.randomUUID();

    await expect(
      enforceTranscriptionRateLimits(
        request,
        testEnv(),
        rateLimitInput(segmentId, { chunkCount: 2 }),
        2,
      ),
    ).resolves.toMatchObject({ allowed: true });
    const secondPart = rateLimitInput(segmentId, {
      chunkCount: 2,
      chunkIndex: 2,
      chunkStartMs: 120_000,
      durationMs: 60_000,
      audioSha256: "8".repeat(64),
    });
    await expect(
      enforceTranscriptionRateLimits(request, testEnv(), secondPart, 2),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      enforceTranscriptionRateLimits(request, testEnv(), secondPart, 2),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      enforceTranscriptionRateLimits(request, testEnv(), secondPart, 2),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "attempt-limit",
    });

    await expect(
      enforceTranscriptionRateLimits(
        request,
        testEnv(),
        rateLimitInput(),
        2,
      ),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      enforceTranscriptionRateLimits(
        request,
        testEnv(),
        rateLimitInput(),
        2,
      ),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      enforceTranscriptionRateLimits(
        request,
        testEnv(),
        rateLimitInput(),
        2,
      ),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("enforces twenty logical segments per rolling hour for one IP", async () => {
    const ipAddress = `198.18.${Math.floor(Math.random() * 100)}.1`;
    const decisions = [];
    for (let index = 0; index < 21; index += 1) {
      decisions.push(
        await enforceTranscriptionRateLimits(
          await requestFor(ipAddress, uniqueBrowserId(index + 1_000_000)),
          testEnv(),
          rateLimitInput(),
          2,
        ),
      );
    }

    expect(decisions.slice(0, 20).every((decision) => decision.allowed)).toBe(
      true,
    );
    expect(decisions[20]).toMatchObject({ allowed: false });
  });

  it("binds an ordered segment contract and bounds provider attempts per part", async () => {
    const limiter = env.RATE_LIMITER.getByName(
      `segment-contract-${crypto.randomUUID()}`,
    );
    const base = {
      segmentKey: "a".repeat(64),
      browserKey: "b".repeat(64),
      chunkCount: 2,
      chunkIndex: 1,
      chunkStartMs: 0,
      durationMs: 120_000,
      audioSha256: "c".repeat(64),
      maxAttempts: 2 as const,
    };

    const first = await limiter.reservePartAttempt(base);
    expect(first).toMatchObject({ allowed: true });
    const retry = await limiter.reservePartAttempt(base);
    expect(retry).toMatchObject({ allowed: true });
    await expect(limiter.reservePartAttempt(base)).resolves.toMatchObject({
      allowed: false,
      reason: "attempt-limit",
    });

    if (!retry.leaseId) {
      throw new Error("Expected a synthetic attempt lease.");
    }
    await limiter.releasePartAttempt(base.segmentKey, retry.leaseId);
    await expect(limiter.reservePartAttempt(base)).resolves.toMatchObject({
      allowed: true,
    });

    await expect(
      limiter.reservePartAttempt({
        ...base,
        chunkIndex: 2,
        chunkStartMs: 120_000,
        durationMs: 60_000,
        audioSha256: "d".repeat(64),
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("rejects changed, skipped, overlapping, and cross-browser part contracts", async () => {
    const limiter = env.RATE_LIMITER.getByName(
      `segment-invalid-${crypto.randomUUID()}`,
    );
    const base = {
      segmentKey: "e".repeat(64),
      browserKey: "f".repeat(64),
      chunkCount: 3,
      chunkIndex: 1,
      chunkStartMs: 0,
      durationMs: 100_000,
      audioSha256: "1".repeat(64),
      maxAttempts: 3 as const,
    };
    await expect(limiter.reservePartAttempt(base)).resolves.toMatchObject({
      allowed: true,
    });

    for (const invalid of [
      { ...base, chunkCount: 2 },
      { ...base, browserKey: "2".repeat(64) },
      {
        ...base,
        chunkIndex: 2,
        chunkStartMs: 99_999,
        audioSha256: "3".repeat(64),
      },
      {
        ...base,
        chunkIndex: 3,
        chunkStartMs: 100_000,
        audioSha256: "4".repeat(64),
      },
    ]) {
      await expect(limiter.reservePartAttempt(invalid)).resolves.toMatchObject({
        allowed: false,
        reason: "contract-invalid",
      });
    }
  });

  it("deallocates an invalid empty segment object and recreates its schema safely", async () => {
    const limiter = env.RATE_LIMITER.getByName(
      `segment-cleanup-${crypto.randomUUID()}`,
    );
    const base = {
      segmentKey: "5".repeat(64),
      browserKey: "6".repeat(64),
      chunkCount: 2,
      chunkIndex: 2,
      chunkStartMs: 100_000,
      durationMs: 50_000,
      audioSha256: "7".repeat(64),
      maxAttempts: 2 as const,
    };

    await expect(limiter.reservePartAttempt(base)).resolves.toMatchObject({
      allowed: false,
      reason: "contract-invalid",
    });
    // The immediate cleanup alarm may already have run by the time the local
    // test harness observes it.
    await runDurableObjectAlarm(limiter);
    await expect(
      limiter.reservePartAttempt({
        ...base,
        chunkIndex: 1,
        chunkStartMs: 0,
      }),
    ).resolves.toMatchObject({ allowed: true });
  });
});

describe("guidance rate-limit Durable Objects", () => {
  it("allows thirty one-off prompts per browser per rolling hour", async () => {
    const browserId = uniqueBrowserId(Math.floor(Math.random() * 1_000_000));
    const request = await requestFor("203.0.113.240", browserId);
    const decisions = [];
    for (let index = 0; index < 31; index += 1) {
      decisions.push(
        await enforceGuidanceRateLimits(
          request,
          testEnv(),
          crypto.randomUUID(),
        ),
      );
    }
    expect(decisions.slice(0, 30).every((decision) => decision.allowed)).toBe(
      true,
    );
    expect(decisions[30]).toMatchObject({ allowed: false });
  });
});
