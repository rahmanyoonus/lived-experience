import { describe, expect, it, vi } from "vitest";

import type { GuestPersistence } from "../data";
import {
  checkDeviceReadiness,
  checkTranscriptionReadiness,
} from "./readiness";

describe("capture readiness", () => {
  it("requires a committed device-storage probe", async () => {
    const probeReadiness = vi.fn().mockResolvedValue({
      persisted: true,
      acknowledged_at: 1,
      value: true,
    });
    const persistence = {
      probeReadiness,
    } as unknown as GuestPersistence;

    await expect(
      checkDeviceReadiness(persistence, {
        estimate: () =>
          Promise.resolve({ quota: 100_000_000, usage: 1_000_000 }),
      }),
    ).resolves.toEqual({ status: "ready" });
    expect(probeReadiness).toHaveBeenCalledOnce();
  });

  it("blocks capture after a failed write or insufficient recording headroom", async () => {
    const failedPersistence = {
      probeReadiness: vi.fn().mockRejectedValue(new Error("synthetic failure")),
    } as unknown as GuestPersistence;
    await expect(
      checkDeviceReadiness(failedPersistence, undefined),
    ).resolves.toEqual({
      status: "blocked",
      reason: "device-storage-unavailable",
    });

    const workingPersistence = {
      probeReadiness: vi.fn().mockResolvedValue({
        persisted: true,
        acknowledged_at: 1,
        value: true,
      }),
    } as unknown as GuestPersistence;
    await expect(
      checkDeviceReadiness(workingPersistence, {
        estimate: () =>
          Promise.resolve({ quota: 30_000_000, usage: 20_000_000 }),
      }),
    ).resolves.toEqual({
      status: "blocked",
      reason: "device-storage-low",
    });
  });

  it("treats an unavailable transcription boundary as degraded, not blocking", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "degraded",
          transcription: "unavailable",
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(checkTranscriptionReadiness(fetcher)).resolves.toEqual({
      status: "degraded",
    });
  });

  it("accepts only the exact healthy transcription response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ status: "ready", transcription: "ready" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(checkTranscriptionReadiness(fetcher)).resolves.toEqual({
      status: "ready",
    });
  });
});
