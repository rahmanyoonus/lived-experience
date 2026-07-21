import type { GuestPersistence } from "../data";
import { getSupabaseClient } from "../lib/supabase";

const MIN_CAPTURE_HEADROOM_BYTES = 24 * 1024 * 1024;
const READINESS_TIMEOUT_MS = 5_000;

export type DeviceReadiness =
  | { readonly status: "ready" }
  | {
      readonly status: "blocked";
      readonly reason: "device-storage-unavailable" | "device-storage-low";
    };

export type CloudReadiness =
  | { readonly status: "ready" }
  | {
      readonly status: "degraded";
      readonly reason: "cloud-unavailable" | "authentication-unavailable";
    };

export type TranscriptionReadiness =
  | { readonly status: "ready" }
  | { readonly status: "degraded" };

interface StorageEstimate {
  readonly quota?: number;
  readonly usage?: number;
}

interface StorageManagerLike {
  estimate?: () => Promise<StorageEstimate>;
}

export async function checkDeviceReadiness(
  persistence: GuestPersistence,
  storageManager: StorageManagerLike | undefined = navigator.storage,
): Promise<DeviceReadiness> {
  try {
    await persistence.probeReadiness();
  } catch {
    return { status: "blocked", reason: "device-storage-unavailable" };
  }

  if (!storageManager?.estimate) {
    return { status: "ready" };
  }

  try {
    const estimate = await storageManager.estimate();
    if (
      typeof estimate.quota === "number" &&
      typeof estimate.usage === "number" &&
      estimate.quota - estimate.usage < MIN_CAPTURE_HEADROOM_BYTES
    ) {
      return { status: "blocked", reason: "device-storage-low" };
    }
  } catch {
    // A committed IndexedDB transaction remains the authoritative check when
    // the optional browser quota estimate is unavailable.
  }

  return { status: "ready" };
}

export async function checkCloudReadiness(
  authenticated: boolean,
): Promise<CloudReadiness> {
  const client = getSupabaseClient();
  if (!client) {
    return { status: "degraded", reason: "cloud-unavailable" };
  }

  try {
    if (authenticated) {
      const { data, error } = await client.auth.getUser();
      if (error || !data.user) {
        return {
          status: "degraded",
          reason: "authentication-unavailable",
        };
      }
    }

    const rawResult: unknown = await client.rpc("app_readiness");
    if (
      typeof rawResult !== "object" ||
      rawResult === null ||
      !("data" in rawResult) ||
      !("error" in rawResult)
    ) {
      return { status: "degraded", reason: "cloud-unavailable" };
    }
    const data: unknown = rawResult.data;
    const error: unknown = rawResult.error;
    if (error || typeof data !== "object" || data === null) {
      return { status: "degraded", reason: "cloud-unavailable" };
    }
    const response = data as Record<string, unknown>;
    if (
      response.status !== "ready" ||
      (authenticated && response.authenticated !== true)
    ) {
      return {
        status: "degraded",
        reason: authenticated
          ? "authentication-unavailable"
          : "cloud-unavailable",
      };
    }
    return { status: "ready" };
  } catch {
    return { status: "degraded", reason: "cloud-unavailable" };
  }
}

export async function checkTranscriptionReadiness(
  fetcher: typeof fetch = fetch,
): Promise<TranscriptionReadiness> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), READINESS_TIMEOUT_MS);
  try {
    const response = await fetcher("/api/readiness", {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      return { status: "degraded" };
    }
    const body = (await response.json()) as unknown;
    if (
      typeof body !== "object" ||
      body === null ||
      (body as Record<string, unknown>).status !== "ready" ||
      (body as Record<string, unknown>).transcription !== "ready"
    ) {
      return { status: "degraded" };
    }
    return { status: "ready" };
  } catch {
    return { status: "degraded" };
  } finally {
    clearTimeout(timeout);
  }
}
