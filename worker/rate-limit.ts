import { DurableObject } from "cloudflare:workers";

const BROWSER_COOKIE_NAME = "__Host-le_rl_browser";
const BROWSER_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const IDEMPOTENCY_RETENTION_MS = 30 * DAY_MS;
const RATE_LIMIT_SECRET_MIN_LENGTH = 32;
const BROWSER_ID = /^[A-Za-z0-9_-]{22}$/;
const SIGNED_BROWSER_COOKIE = /^([A-Za-z0-9_-]{22})\.([0-9a-f]{64})$/;
const HASHED_SEGMENT_ID = /^[0-9a-f]{64}$/;
const AUDIO_SHA256 = /^[0-9a-f]{64}$/;
const ATTEMPT_LEASE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const BROWSER_RATE_LIMIT_POLICY = {
  hourlyLimit: 3,
  dailyLimit: 10,
} as const;

export const IP_RATE_LIMIT_POLICY = {
  hourlyLimit: 20,
} as const;

export const GUIDANCE_BROWSER_RATE_LIMIT_POLICY = {
  hourlyLimit: 30,
  dailyLimit: 90,
} as const;

export const GUIDANCE_IP_RATE_LIMIT_POLICY = {
  hourlyLimit: 100,
} as const;

interface RateLimitPolicy {
  readonly hourlyLimit: number;
  readonly dailyLimit?: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly newReservation?: boolean;
  readonly retryAfterSeconds?: number;
}

export interface TranscriptionRateLimitResult extends RateLimitDecision {
  readonly setCookie?: string;
  readonly reason?: "attempt-limit" | "contract-invalid";
  readonly attemptLease?: {
    readonly segmentKey: string;
    readonly leaseId: string;
  };
}

export interface TranscriptionRateLimitInput {
  readonly segmentId: string;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly chunkStartMs: number;
  readonly durationMs: number;
  readonly audioSha256: string;
}

export interface TranscriptionBrowserSession {
  readonly setCookie?: string;
}

export type GuidanceRateLimitResult = RateLimitDecision;

export interface TranscriptionPartAttemptInput {
  readonly segmentKey: string;
  readonly browserKey: string;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly chunkStartMs: number;
  readonly durationMs: number;
  readonly audioSha256: string;
  readonly maxAttempts: 2 | 3;
}

export interface TranscriptionPartAttemptDecision {
  readonly allowed: boolean;
  readonly leaseId?: string;
  readonly reason?: "attempt-limit" | "contract-invalid";
}

interface ReservationEvaluation extends RateLimitDecision {
  readonly retainedTimestamps: readonly number[];
}

function oldestTimestamp(
  timestamps: readonly number[],
  cutoff: number,
): number | undefined {
  return timestamps.find((timestamp) => timestamp > cutoff);
}

/**
 * Evaluates a rolling-window reservation without storing request content or
 * identifiers. Exported so the exact window boundaries remain unit-testable.
 */
export function evaluateRateLimitReservation(
  storedTimestamps: readonly number[],
  now: number,
  policy: RateLimitPolicy,
): ReservationEvaluation {
  const longestWindowMs = policy.dailyLimit === undefined ? HOUR_MS : DAY_MS;
  const retentionCutoff = now - longestWindowMs;
  const retainedTimestamps = storedTimestamps
    .filter(
      (timestamp) =>
        Number.isSafeInteger(timestamp) &&
        timestamp >= 0 &&
        timestamp > retentionCutoff,
    )
    .sort((left, right) => left - right);

  const hourlyCutoff = now - HOUR_MS;
  const hourlyTimestamps = retainedTimestamps.filter(
    (timestamp) => timestamp > hourlyCutoff,
  );
  const hourlyExceeded = hourlyTimestamps.length >= policy.hourlyLimit;
  const dailyExceeded =
    policy.dailyLimit !== undefined &&
    retainedTimestamps.length >= policy.dailyLimit;

  if (!hourlyExceeded && !dailyExceeded) {
    return {
      allowed: true,
      retainedTimestamps: [...retainedTimestamps, now],
    };
  }

  let retryAfterMs = 0;
  if (hourlyExceeded) {
    const oldestHourlyTimestamp = oldestTimestamp(
      retainedTimestamps,
      hourlyCutoff,
    );
    if (oldestHourlyTimestamp !== undefined) {
      retryAfterMs = Math.max(
        retryAfterMs,
        oldestHourlyTimestamp + HOUR_MS - now,
      );
    }
  }
  if (dailyExceeded) {
    const oldestDailyTimestamp = oldestTimestamp(
      retainedTimestamps,
      now - DAY_MS,
    );
    if (oldestDailyTimestamp !== undefined) {
      retryAfterMs = Math.max(
        retryAfterMs,
        oldestDailyTimestamp + DAY_MS - now,
      );
    }
  }

  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1_000)),
    retainedTimestamps,
  };
}

function validStoredTimestamps(value: unknown): readonly number[] {
  if (!Array.isArray(value)) {
    throw new Error("Rate limit state is invalid.");
  }
  const timestamps: number[] = [];
  for (const candidate of value as unknown[]) {
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate)
    ) {
      throw new Error("Rate limit state is invalid.");
    }
    timestamps.push(candidate);
  }
  return timestamps;
}

export class TranscriptionRateLimiter extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private schemaInitialised = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ensureSchema();
  }

  private ensureSchema(): void {
    if (this.schemaInitialised) {
      return;
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS reservations (
        segment_key TEXT PRIMARY KEY,
        occurred_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS reservations_occurred_at
        ON reservations (occurred_at);
      CREATE TABLE IF NOT EXISTS segment_contracts (
        segment_key TEXT PRIMARY KEY,
        browser_key TEXT NOT NULL,
        chunk_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS segment_part_attempts (
        segment_key TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_start_ms INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        audio_sha256 TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        PRIMARY KEY (segment_key, chunk_index)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS segment_attempt_leases (
        lease_id TEXT PRIMARY KEY,
        segment_key TEXT NOT NULL,
        chunk_index INTEGER NOT NULL
      ) WITHOUT ROWID;
    `);
    this.schemaInitialised = true;
  }

  private deleteExpiredRows(now: number): void {
    const cutoff = now - IDEMPOTENCY_RETENTION_MS;
    this.sql.exec(
      `DELETE FROM segment_attempt_leases
        WHERE segment_key IN (
          SELECT segment_key FROM segment_contracts WHERE created_at <= ?
        )`,
      cutoff,
    );
    this.sql.exec(
      `DELETE FROM segment_part_attempts
        WHERE segment_key IN (
          SELECT segment_key FROM segment_contracts WHERE created_at <= ?
        )`,
      cutoff,
    );
    this.sql.exec(
      "DELETE FROM segment_contracts WHERE created_at <= ?",
      cutoff,
    );
    this.sql.exec(
      "DELETE FROM reservations WHERE occurred_at <= ?",
      cutoff,
    );
  }

  private nextRetentionAlarm(): number | null {
    const reservation = this.sql
      .exec<{ expires_at: number | null }>(
        `SELECT MIN(occurred_at) + ? AS expires_at FROM reservations`,
        IDEMPOTENCY_RETENTION_MS,
      )
      .one().expires_at;
    const contract = this.sql
      .exec<{ expires_at: number | null }>(
        `SELECT MIN(created_at) + ? AS expires_at FROM segment_contracts`,
        IDEMPOTENCY_RETENTION_MS,
      )
      .one().expires_at;
    if (reservation === null) {
      return contract;
    }
    if (contract === null) {
      return reservation;
    }
    return Math.min(reservation, contract);
  }

  private async scheduleRetentionAlarm(): Promise<void> {
    const next = this.nextRetentionAlarm();
    if (next === null) {
      // Let the alarm own full deallocation so a request cannot race a
      // deleteAll after another event has admitted fresh state.
      await this.ctx.storage.setAlarm(Date.now() + 1);
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, next));
  }

  async reserve(
    scope: "browser" | "ip" | "guidance-browser" | "guidance-ip",
    segmentKey: string,
  ): Promise<RateLimitDecision> {
    this.ensureSchema();
    if (!HASHED_SEGMENT_ID.test(segmentKey)) {
      throw new Error("Segment reservation key is invalid.");
    }
    const policy: RateLimitPolicy =
      scope === "browser"
        ? BROWSER_RATE_LIMIT_POLICY
        : scope === "ip"
          ? IP_RATE_LIMIT_POLICY
          : scope === "guidance-browser"
            ? GUIDANCE_BROWSER_RATE_LIMIT_POLICY
            : GUIDANCE_IP_RATE_LIMIT_POLICY;

    const decision: RateLimitDecision =
      this.ctx.storage.transactionSync(() => {
        const now = Date.now();
        this.deleteExpiredRows(now);

      const existing = this.sql
        .exec<{ occurred_at: number }>(
          "SELECT occurred_at FROM reservations WHERE segment_key = ?",
          segmentKey,
        )
        .toArray();
      if (existing.length > 0) {
        return { allowed: true };
      }

      const longestWindowMs =
        policy.dailyLimit === undefined ? HOUR_MS : DAY_MS;
      const storedTimestamps = this.sql
        .exec<{ occurred_at: number }>(
          `SELECT occurred_at
             FROM reservations
            WHERE occurred_at > ?
            ORDER BY occurred_at`,
          now - longestWindowMs,
        )
        .toArray()
        .map((row) => row.occurred_at);
      validStoredTimestamps(storedTimestamps);
      const evaluation = evaluateRateLimitReservation(
        storedTimestamps,
        now,
        policy,
      );

      if (evaluation.allowed) {
        this.sql.exec(
          `INSERT INTO reservations (segment_key, occurred_at)
           VALUES (?, ?)`,
          segmentKey,
          now,
        );
      }

      return {
        allowed: evaluation.allowed,
        ...(evaluation.allowed ? { newReservation: true } : {}),
        ...(evaluation.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: evaluation.retryAfterSeconds }),
      };
      });
    await this.scheduleRetentionAlarm();
    return decision;
  }

  async releaseReservation(segmentKey: string): Promise<void> {
    this.ensureSchema();
    if (!HASHED_SEGMENT_ID.test(segmentKey)) {
      throw new Error("Segment reservation key is invalid.");
    }
    this.sql.exec(
      "DELETE FROM reservations WHERE segment_key = ?",
      segmentKey,
    );
    await this.scheduleRetentionAlarm();
  }

  async reservePartAttempt(
    input: TranscriptionPartAttemptInput,
  ): Promise<TranscriptionPartAttemptDecision> {
    this.ensureSchema();
    if (
      !HASHED_SEGMENT_ID.test(input.segmentKey) ||
      !HASHED_SEGMENT_ID.test(input.browserKey) ||
      !AUDIO_SHA256.test(input.audioSha256) ||
      !Number.isSafeInteger(input.chunkIndex) ||
      input.chunkIndex < 1 ||
      !Number.isSafeInteger(input.chunkCount) ||
      input.chunkCount < 1 ||
      input.chunkCount > 16 ||
      input.chunkIndex > input.chunkCount ||
      !Number.isSafeInteger(input.chunkStartMs) ||
      input.chunkStartMs < 0 ||
      !Number.isSafeInteger(input.durationMs) ||
      input.durationMs < 1 ||
      input.durationMs > 4 * 60 * 1_000 ||
      input.chunkStartMs + input.durationMs > 30 * 60 * 1_000 ||
      (input.maxAttempts !== 2 && input.maxAttempts !== 3)
    ) {
      throw new Error("Transcription part attempt is invalid.");
    }

    const decision: TranscriptionPartAttemptDecision =
      this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.deleteExpiredRows(now);
      const contracts = this.sql
        .exec<{
          browser_key: string;
          chunk_count: number;
          created_at: number;
        }>(
          `SELECT browser_key, chunk_count, created_at
             FROM segment_contracts
            WHERE segment_key = ?`,
          input.segmentKey,
        )
        .toArray();
      const contract = contracts[0];
      if (!contract) {
        if (input.chunkIndex !== 1 || input.chunkStartMs !== 0) {
          return { allowed: false, reason: "contract-invalid" };
        }
        this.sql.exec(
          `INSERT INTO segment_contracts
             (segment_key, browser_key, chunk_count, created_at)
           VALUES (?, ?, ?, ?)`,
          input.segmentKey,
          input.browserKey,
          input.chunkCount,
          now,
        );
      } else if (
        contract.browser_key !== input.browserKey ||
        contract.chunk_count !== input.chunkCount ||
        contract.created_at <= now - IDEMPOTENCY_RETENTION_MS
      ) {
        return { allowed: false, reason: "contract-invalid" };
      }

      const existingParts = this.sql
        .exec<{
          chunk_index: number;
          chunk_start_ms: number;
          duration_ms: number;
          audio_sha256: string;
          attempt_count: number;
        }>(
          `SELECT chunk_index, chunk_start_ms, duration_ms,
                  audio_sha256, attempt_count
             FROM segment_part_attempts
            WHERE segment_key = ?
            ORDER BY chunk_index`,
          input.segmentKey,
        )
        .toArray();
      const existingPart = existingParts.find(
        (part) => part.chunk_index === input.chunkIndex,
      );
      if (existingPart) {
        if (
          existingPart.chunk_start_ms !== input.chunkStartMs ||
          existingPart.duration_ms !== input.durationMs ||
          existingPart.audio_sha256 !== input.audioSha256
        ) {
          return { allowed: false, reason: "contract-invalid" };
        }
        if (existingPart.attempt_count >= input.maxAttempts) {
          return { allowed: false, reason: "attempt-limit" };
        }
        this.sql.exec(
          `UPDATE segment_part_attempts
              SET attempt_count = attempt_count + 1
            WHERE segment_key = ? AND chunk_index = ?`,
          input.segmentKey,
          input.chunkIndex,
        );
      } else {
        const previous = existingParts.at(-1);
        const expectedIndex = (previous?.chunk_index ?? 0) + 1;
        const expectedStart = previous
          ? previous.chunk_start_ms + previous.duration_ms
          : 0;
        if (
          input.chunkIndex !== expectedIndex ||
          input.chunkStartMs !== expectedStart
        ) {
          return { allowed: false, reason: "contract-invalid" };
        }
        this.sql.exec(
          `INSERT INTO segment_part_attempts
             (segment_key, chunk_index, chunk_start_ms, duration_ms,
              audio_sha256, attempt_count)
           VALUES (?, ?, ?, ?, ?, 1)`,
          input.segmentKey,
          input.chunkIndex,
          input.chunkStartMs,
          input.durationMs,
          input.audioSha256,
        );
      }

      const leaseId = crypto.randomUUID();
      this.sql.exec(
        `INSERT INTO segment_attempt_leases
           (lease_id, segment_key, chunk_index)
         VALUES (?, ?, ?)`,
        leaseId,
        input.segmentKey,
        input.chunkIndex,
      );
      return { allowed: true, leaseId };
      });
    await this.scheduleRetentionAlarm();
    return decision;
  }

  async releasePartAttempt(
    segmentKey: string,
    leaseId: string,
  ): Promise<void> {
    this.ensureSchema();
    if (
      !HASHED_SEGMENT_ID.test(segmentKey) ||
      !ATTEMPT_LEASE_ID.test(leaseId)
    ) {
      throw new Error("Transcription attempt lease is invalid.");
    }
    this.ctx.storage.transactionSync(() => {
      const leases = this.sql
        .exec<{ chunk_index: number }>(
          `SELECT chunk_index
             FROM segment_attempt_leases
            WHERE lease_id = ? AND segment_key = ?`,
          leaseId,
          segmentKey,
        )
        .toArray();
      const lease = leases[0];
      if (!lease) {
        return;
      }
      this.sql.exec(
        `DELETE FROM segment_attempt_leases
          WHERE lease_id = ? AND segment_key = ?`,
        leaseId,
        segmentKey,
      );
      this.sql.exec(
        `UPDATE segment_part_attempts
            SET attempt_count = MAX(0, attempt_count - 1)
          WHERE segment_key = ? AND chunk_index = ?`,
        segmentKey,
        lease.chunk_index,
      );
      this.sql.exec(
        `DELETE FROM segment_part_attempts
          WHERE segment_key = ?
            AND chunk_index = ?
            AND attempt_count = 0
            AND NOT EXISTS (
              SELECT 1 FROM segment_part_attempts AS later
               WHERE later.segment_key = ?
                 AND later.chunk_index > ?
            )`,
        segmentKey,
        lease.chunk_index,
        segmentKey,
        lease.chunk_index,
      );
    });
    await this.scheduleRetentionAlarm();
  }

  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
      this.ctx.storage.transactionSync(() => {
        this.deleteExpiredRows(Date.now());
      });
      const next = this.nextRetentionAlarm();
      if (next === null) {
        await this.ctx.storage.deleteAll();
        this.schemaInitialised = false;
        return;
      }
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, next));
    });
  }
}

async function browserIdFromCookie(
  cookieHeader: string | null,
  hmacKey: CryptoKey,
): Promise<string | null> {
  if (!cookieHeader) {
    return null;
  }

  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name !== BROWSER_COOKIE_NAME) {
      continue;
    }
    const match = SIGNED_BROWSER_COOKIE.exec(value);
    const browserId = match?.[1];
    const suppliedSignature = match?.[2];
    if (!browserId || !suppliedSignature) {
      return null;
    }
    const expectedSignature = await hmacIdentity(
      hmacKey,
      "browser-cookie",
      browserId,
    );
    let difference = expectedSignature.length ^ suppliedSignature.length;
    for (
      let index = 0;
      index < Math.min(expectedSignature.length, suppliedSignature.length);
      index += 1
    ) {
      difference |=
        expectedSignature.charCodeAt(index) ^
        suppliedSignature.charCodeAt(index);
    }
    if (difference === 0) {
      return browserId;
    }
    return null;
  }
  return null;
}

function createBrowserId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function browserCookie(
  browserId: string,
  hmacKey: CryptoKey,
): Promise<string> {
  const signature = await hmacIdentity(
    hmacKey,
    "browser-cookie",
    browserId,
  );
  return `${BROWSER_COOKIE_NAME}=${browserId}.${signature}; Path=/; Max-Age=${BROWSER_COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function hmacIdentity(
  key: CryptoKey,
  scope: "browser" | "browser-cookie" | "guidance" | "ip" | "segment",
  identity: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${scope}:${identity}`),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function createSignedBrowserCookieValue(
  secret: string,
  browserId: string,
): Promise<string> {
  if (secret.trim().length < RATE_LIMIT_SECRET_MIN_LENGTH) {
    throw new Error("Rate limit secret is unavailable.");
  }
  if (!BROWSER_ID.test(browserId)) {
    throw new Error("Browser identity is invalid.");
  }
  const key = await importHmacKey(secret.trim());
  const signature = await hmacIdentity(key, "browser-cookie", browserId);
  return `${browserId}.${signature}`;
}

export async function establishTranscriptionBrowserSession(
  request: Request,
  env: Env,
): Promise<TranscriptionBrowserSession> {
  const secret = env.RATE_LIMIT_SECRET?.trim();
  if (!secret || secret.length < RATE_LIMIT_SECRET_MIN_LENGTH) {
    throw new Error("Rate limit secret is unavailable.");
  }
  const hmacKey = await importHmacKey(secret);
  const existingBrowserId = await browserIdFromCookie(
    request.headers.get("Cookie"),
    hmacKey,
  );
  if (existingBrowserId) {
    return {};
  }
  const browserId = createBrowserId();
  return { setCookie: await browserCookie(browserId, hmacKey) };
}

export async function enforceTranscriptionRateLimits(
  request: Request,
  env: Env,
  input: TranscriptionRateLimitInput,
  maxAttempts: 2 | 3,
): Promise<TranscriptionRateLimitResult> {
  const secret = env.RATE_LIMIT_SECRET?.trim();
  if (!secret || secret.length < RATE_LIMIT_SECRET_MIN_LENGTH) {
    throw new Error("Rate limit secret is unavailable.");
  }

  const ipAddress = request.headers.get("CF-Connecting-IP")?.trim();
  if (!ipAddress) {
    throw new Error("Client network identity is unavailable.");
  }
  if (!UUID.test(input.segmentId)) {
    throw new Error("Segment identity is invalid.");
  }

  const hmacKey = await importHmacKey(secret);
  const existingBrowserId = await browserIdFromCookie(
    request.headers.get("Cookie"),
    hmacKey,
  );
  if (!existingBrowserId) {
    throw new Error("Browser transcription session is unavailable.");
  }
  const browserId = existingBrowserId;
  const [browserKey, ipKey, segmentKey] = await Promise.all([
    hmacIdentity(hmacKey, "browser", browserId),
    hmacIdentity(hmacKey, "ip", ipAddress),
    hmacIdentity(hmacKey, "segment", input.segmentId),
  ]);

  const ipLimiter = env.RATE_LIMITER.getByName(`ip:${ipKey}`);
  const ipDecision = await ipLimiter.reserve("ip", segmentKey);
  if (!ipDecision.allowed) {
    return {
      ...ipDecision,
    };
  }

  const browserLimiter = env.RATE_LIMITER.getByName(
    `browser:${browserKey}`,
  );
  // Reservations span independent Durable Objects. Retaining the IP row is
  // safer than an unowned compensating delete, which could remove a
  // concurrent request's valid quota record.
  const browserDecision: RateLimitDecision =
    await browserLimiter.reserve("browser", segmentKey);
  if (!browserDecision.allowed) {
    return { ...browserDecision };
  }

  const segmentLimiter = env.RATE_LIMITER.getByName(
    `segment:${segmentKey}`,
  );
  const attemptDecision = await segmentLimiter.reservePartAttempt({
    segmentKey,
    browserKey,
    chunkIndex: input.chunkIndex,
    chunkCount: input.chunkCount,
    chunkStartMs: input.chunkStartMs,
    durationMs: input.durationMs,
    audioSha256: input.audioSha256,
    maxAttempts,
  });
  if (!attemptDecision.allowed) {
    return {
      allowed: false,
      reason: attemptDecision.reason,
    };
  }
  if (!attemptDecision.leaseId) {
    throw new Error("Transcription attempt lease is unavailable.");
  }
  return {
    allowed: true,
    attemptLease: {
      segmentKey,
      leaseId: attemptDecision.leaseId,
    },
  };
}

export async function enforceGuidanceRateLimits(
  request: Request,
  env: Env,
  requestId: string,
): Promise<GuidanceRateLimitResult> {
  const secret = env.RATE_LIMIT_SECRET?.trim();
  if (!secret || secret.length < RATE_LIMIT_SECRET_MIN_LENGTH) {
    throw new Error("Rate limit secret is unavailable.");
  }
  const ipAddress = request.headers.get("CF-Connecting-IP")?.trim();
  if (!ipAddress) {
    throw new Error("Client network identity is unavailable.");
  }
  if (!UUID.test(requestId)) {
    throw new Error("Guidance request identity is invalid.");
  }

  const hmacKey = await importHmacKey(secret);
  const browserId = await browserIdFromCookie(
    request.headers.get("Cookie"),
    hmacKey,
  );
  if (!browserId) {
    throw new Error("Browser guidance session is unavailable.");
  }
  const [browserKey, ipKey, guidanceKey] = await Promise.all([
    hmacIdentity(hmacKey, "browser", browserId),
    hmacIdentity(hmacKey, "ip", ipAddress),
    hmacIdentity(hmacKey, "guidance", requestId),
  ]);

  const ipDecision = await env.RATE_LIMITER.getByName(
    `guidance-ip:${ipKey}`,
  ).reserve("guidance-ip", guidanceKey);
  if (!ipDecision.allowed) {
    return ipDecision;
  }
  return env.RATE_LIMITER.getByName(
    `guidance-browser:${browserKey}`,
  ).reserve("guidance-browser", guidanceKey);
}
