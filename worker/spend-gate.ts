import { DurableObject } from "cloudflare:workers";

import { OPENAI_TRANSCRIPTION_PROVIDER_POLICY } from "./provider-policy";

const PROVIDER_CALL_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const TRANSCRIPTION_PRICING_POLICY =
  OPENAI_TRANSCRIPTION_PROVIDER_POLICY;

export interface SpendReservationDecision {
  readonly allowed: boolean;
  readonly reservationId?: string;
  readonly retryAfterSeconds?: number;
}

function currentUtcMonth(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

function secondsUntilNextUtcMonth(now: number): number {
  const date = new Date(now);
  const nextMonth = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    1,
  );
  return Math.max(1, Math.ceil((nextMonth - now) / 1_000));
}

export function conservativeTranscriptionReservationNanoUsd(
  durationMs: number,
): number {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1) {
    throw new Error("Provider duration is invalid.");
  }
  const policy = TRANSCRIPTION_PRICING_POLICY;
  const estimatedDurationCost = Math.ceil(
    (durationMs * policy.estimatedNanoUsdPerMinute) / 60_000,
  );
  const maximumTokenEnvelope =
    policy.maxInputTokens * policy.inputNanoUsdPerToken +
    policy.maxOutputTokens * policy.outputNanoUsdPerToken;
  const durationEnvelope =
    estimatedDurationCost * policy.reservationSafetyMultiplier +
    policy.maxOutputTokens * policy.outputNanoUsdPerToken;
  return Math.max(maximumTokenEnvelope, durationEnvelope);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function actualTranscriptionCostNanoUsd(
  responseBody: unknown,
): number | null {
  if (
    typeof responseBody !== "object" ||
    responseBody === null ||
    !("usage" in responseBody)
  ) {
    return null;
  }
  const usage = responseBody.usage;
  if (typeof usage !== "object" || usage === null || !("type" in usage)) {
    return null;
  }

  if (usage.type === "tokens") {
    if (
      !("input_tokens" in usage) ||
      !("output_tokens" in usage) ||
      !nonNegativeSafeInteger(usage.input_tokens) ||
      !nonNegativeSafeInteger(usage.output_tokens)
    ) {
      return null;
    }
    return (
      usage.input_tokens *
        TRANSCRIPTION_PRICING_POLICY.inputNanoUsdPerToken +
      usage.output_tokens *
        TRANSCRIPTION_PRICING_POLICY.outputNanoUsdPerToken
    );
  }

  if (
    usage.type === "duration" &&
    "seconds" in usage &&
    typeof usage.seconds === "number" &&
    Number.isFinite(usage.seconds) &&
    usage.seconds >= 0
  ) {
    return Math.ceil(
      (usage.seconds *
        TRANSCRIPTION_PRICING_POLICY.estimatedNanoUsdPerMinute) /
        60,
    );
  }

  return null;
}

export class TranscriptionSpendGate extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS spend_reservations (
        provider_call_id TEXT PRIMARY KEY,
        month_key TEXT NOT NULL,
        reserved_nano_usd INTEGER NOT NULL,
        actual_nano_usd INTEGER
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS spend_reservations_month
        ON spend_reservations (month_key);
    `);
  }

  reserve(
    providerCallId: string,
    reservationNanoUsd: number,
  ): SpendReservationDecision {
    if (
      !PROVIDER_CALL_ID.test(providerCallId) ||
      !Number.isSafeInteger(reservationNanoUsd) ||
      reservationNanoUsd < 1
    ) {
      throw new Error("Spend reservation is invalid.");
    }

    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const monthKey = currentUtcMonth(now);
      this.sql.exec(
        "DELETE FROM spend_reservations WHERE month_key <> ?",
        monthKey,
      );

      const existing = this.sql
        .exec<{ provider_call_id: string }>(
          `SELECT provider_call_id
             FROM spend_reservations
            WHERE provider_call_id = ?`,
          providerCallId,
        )
        .toArray();
      if (existing.length > 0) {
        return { allowed: true, reservationId: providerCallId };
      }

      const row = this.sql
        .exec<{ total_nano_usd: number | null }>(
          `SELECT SUM(COALESCE(actual_nano_usd, reserved_nano_usd))
                    AS total_nano_usd
             FROM spend_reservations
            WHERE month_key = ?`,
          monthKey,
        )
        .one();
      const currentSpend = row.total_nano_usd ?? 0;
      if (
        currentSpend + reservationNanoUsd >
        TRANSCRIPTION_PRICING_POLICY.operatingMonthlyBudgetNanoUsd
      ) {
        return {
          allowed: false,
          retryAfterSeconds: secondsUntilNextUtcMonth(now),
        };
      }

      this.sql.exec(
        `INSERT INTO spend_reservations
           (provider_call_id, month_key, reserved_nano_usd)
         VALUES (?, ?, ?)`,
        providerCallId,
        monthKey,
        reservationNanoUsd,
      );
      return { allowed: true, reservationId: providerCallId };
    });
  }

  reconcile(providerCallId: string, actualNanoUsd: number): void {
    if (
      !PROVIDER_CALL_ID.test(providerCallId) ||
      !Number.isSafeInteger(actualNanoUsd) ||
      actualNanoUsd < 0
    ) {
      throw new Error("Spend reconciliation is invalid.");
    }

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE spend_reservations
            SET actual_nano_usd = ?
          WHERE provider_call_id = ?
            AND actual_nano_usd IS NULL`,
        actualNanoUsd,
        providerCallId,
      );
    });
  }
}

const SPEND_GATE_OBJECT_NAME = "openai-transcription-budget-v1";

export async function reserveTranscriptionSpend(
  env: Env,
  durationMs: number,
): Promise<SpendReservationDecision> {
  const providerCallId = crypto.randomUUID();
  const reservationNanoUsd =
    conservativeTranscriptionReservationNanoUsd(durationMs);
  return env.SPEND_GATE.getByName(SPEND_GATE_OBJECT_NAME).reserve(
    providerCallId,
    reservationNanoUsd,
  );
}

export async function reconcileTranscriptionSpend(
  env: Env,
  reservationId: string,
  responseBody: unknown,
): Promise<void> {
  const actualNanoUsd = actualTranscriptionCostNanoUsd(responseBody);
  if (actualNanoUsd === null) {
    // Unknown-cost calls retain their conservative reservation.
    return;
  }
  await env.SPEND_GATE.getByName(SPEND_GATE_OBJECT_NAME).reconcile(
    reservationId,
    actualNanoUsd,
  );
}
