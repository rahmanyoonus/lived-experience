import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  actualTranscriptionCostNanoUsd,
  conservativeTranscriptionReservationNanoUsd,
  TRANSCRIPTION_PRICING_POLICY,
} from "./spend-gate";
import { OPENAI_TRANSCRIPTION_PROVIDER_POLICY } from "./provider-policy";

describe("transcription spend calculations", () => {
  it("uses one provider policy for request identity and accounting", () => {
    expect(TRANSCRIPTION_PRICING_POLICY).toBe(
      OPENAI_TRANSCRIPTION_PROVIDER_POLICY,
    );
    expect(TRANSCRIPTION_PRICING_POLICY.model).toBe(
      "gpt-4o-mini-transcribe",
    );
  });

  it("reserves the documented token ceiling or the buffered duration estimate", () => {
    expect(conservativeTranscriptionReservationNanoUsd(60_000)).toBe(
      30_000_000,
    );
    expect(conservativeTranscriptionReservationNanoUsd(4 * 60_000)).toBe(
      34_000_000,
    );
  });

  it("reconciles token and duration usage without accepting malformed usage", () => {
    expect(
      actualTranscriptionCostNanoUsd({
        usage: {
          type: "tokens",
          input_tokens: 100,
          output_tokens: 20,
        },
      }),
    ).toBe(225_000);
    expect(
      actualTranscriptionCostNanoUsd({
        usage: { type: "duration", seconds: 30 },
      }),
    ).toBe(1_500_000);
    expect(actualTranscriptionCostNanoUsd({ usage: {} })).toBeNull();
    expect(actualTranscriptionCostNanoUsd({})).toBeNull();
  });
});

describe("transcription spend-gate Durable Object", () => {
  it("is idempotent by provider call and refuses reservations above the operating cap", async () => {
    const gate = env.SPEND_GATE.getByName(`test-${crypto.randomUUID()}`);
    const firstCallId = crypto.randomUUID();
    const nearlyAllBudget =
      TRANSCRIPTION_PRICING_POLICY.operatingMonthlyBudgetNanoUsd - 1;

    await expect(gate.reserve(firstCallId, nearlyAllBudget)).resolves.toEqual({
      allowed: true,
      reservationId: firstCallId,
    });
    await expect(gate.reserve(firstCallId, nearlyAllBudget)).resolves.toEqual({
      allowed: true,
      reservationId: firstCallId,
    });
    await expect(gate.reserve(crypto.randomUUID(), 2)).resolves.toMatchObject({
      allowed: false,
    });
  });

  it("releases conservative headroom exactly once after known-cost reconciliation", async () => {
    const gate = env.SPEND_GATE.getByName(`test-${crypto.randomUUID()}`);
    const firstCallId = crypto.randomUUID();
    const reservation =
      TRANSCRIPTION_PRICING_POLICY.operatingMonthlyBudgetNanoUsd;

    await expect(gate.reserve(firstCallId, reservation)).resolves.toMatchObject({
      allowed: true,
    });
    await gate.reconcile(firstCallId, 1);
    await gate.reconcile(firstCallId, reservation);
    await expect(
      gate.reserve(crypto.randomUUID(), reservation - 1),
    ).resolves.toMatchObject({ allowed: true });
  });
});
