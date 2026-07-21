import { z } from "zod";

import {
  MAX_SEGMENT_DURATION_MS,
  MAX_TRANSCRIPTION_PART_BYTES,
  MAX_TRANSCRIPTION_PART_DURATION_MS,
  MAX_TRANSCRIPTION_PARTS,
} from "./recorder";

export const TRANSCRIPTION_SEGMENT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_CACHED_PART_RESULTS = 64;
export const PARTIAL_TRANSCRIPTION_CACHE_TTL_MS = 2 * 60 * 1_000;

interface CachedPartResult {
  readonly result: TranscriptionResult;
  readonly expiresAt: number;
}

const partialResultCache = new Map<string, CachedPartResult>();

const uncertaintySchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  audioStartMs: z.number().nonnegative(),
  audioEndMs: z.number().positive(),
  confidence: z.number().min(0).max(1).optional(),
});

const transcriptionResponseSchema = z.object({
  text: z.string(),
  provider: z.string().min(1),
  model: z.string().min(1),
  language: z.literal("en"),
  uncertainties: z.array(uncertaintySchema).default([]),
});

const transcriptionErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});

export interface TranscriptionAudioPart {
  /** Independently playable output from one completed MediaRecorder run. */
  readonly audio: Blob;
  readonly durationMs: number;
  readonly startOffsetMs: number;
}

export interface TranscriptionRequest {
  readonly audioParts: readonly TranscriptionAudioPart[];
  readonly segmentId: string;
  readonly durationMs: number;
  readonly signal?: AbortSignal;
}

export type TranscriptionResult = z.infer<typeof transcriptionResponseSchema>;

export class TranscriptionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "TranscriptionError";
    this.code = code;
    this.retryable = retryable;
  }
}

interface DeadlineSignal {
  readonly signal: AbortSignal;
  readonly didTimeout: () => boolean;
  readonly dispose: () => void;
}

function segmentDeadline(
  externalSignal: AbortSignal | undefined,
): DeadlineSignal {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TRANSCRIPTION_SEGMENT_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  }
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", forwardAbort);
    },
  };
}

function validateParts(
  parts: readonly TranscriptionAudioPart[],
  durationMs: number,
): void {
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1 ||
    durationMs > MAX_SEGMENT_DURATION_MS ||
    parts.length < 1 ||
    parts.length > MAX_TRANSCRIPTION_PARTS
  ) {
    throw new TranscriptionError(
      "TRANSCRIPTION_PARTS_INVALID",
      "The saved recording could not be prepared safely. The original audio remains on this device.",
      false,
    );
  }

  let expectedStartOffsetMs = 0;
  for (const part of parts) {
    if (
      !(part.audio instanceof Blob) ||
      part.audio.size < 1 ||
      part.audio.size > MAX_TRANSCRIPTION_PART_BYTES ||
      !Number.isSafeInteger(part.durationMs) ||
      part.durationMs < 1 ||
      part.durationMs > MAX_TRANSCRIPTION_PART_DURATION_MS ||
      !Number.isSafeInteger(part.startOffsetMs) ||
      part.startOffsetMs !== expectedStartOffsetMs
    ) {
      throw new TranscriptionError(
        "TRANSCRIPTION_PARTS_INVALID",
        "The saved recording could not be prepared safely. The original audio remains on this device.",
        false,
      );
    }
    expectedStartOffsetMs += part.durationMs;
  }
  if (expectedStartOffsetMs !== durationMs) {
    throw new TranscriptionError(
      "TRANSCRIPTION_PARTS_INVALID",
      "The saved recording could not be prepared safely. The original audio remains on this device.",
      false,
    );
  }
}

async function audioSha256(audio: Blob): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new TranscriptionError(
      "TRANSCRIPTION_DIGEST_UNAVAILABLE",
      "This browser could not verify the recording before upload. The original audio remains saved on this device.",
      false,
    );
  }
  try {
    const digest = await subtle.digest("SHA-256", await audio.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch {
    throw new TranscriptionError(
      "TRANSCRIPTION_DIGEST_UNAVAILABLE",
      "This browser could not verify the recording before upload. The original audio remains saved on this device.",
      false,
    );
  }
}

function partialResultKey(
  segmentId: string,
  chunkIndex: number,
  sha256: string,
  part: TranscriptionAudioPart,
): string {
  return [
    segmentId,
    chunkIndex,
    sha256,
    part.durationMs,
    part.startOffsetMs,
  ].join("|");
}

function responseIsRetryable(response: Response): boolean {
  return (
    response.status === 408 ||
    response.status === 429 ||
    response.status >= 500
  );
}

async function errorFromResponse(
  response: Response,
): Promise<TranscriptionError> {
  const body: unknown = await response.json().catch(() => null);
  const parsedError = transcriptionErrorSchema.safeParse(body);
  return new TranscriptionError(
    parsedError.success && parsedError.data.code
      ? parsedError.data.code
      : "TRANSCRIPTION_FAILED",
    parsedError.success && parsedError.data.message
      ? parsedError.data.message
      : "The transcript could not be prepared yet. Your recording remains saved on this device.",
    responseIsRetryable(response),
  );
}

async function establishBrowserSession(
  signal: AbortSignal,
  didTimeout: () => boolean,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/transcription-session", {
      method: "POST",
      credentials: "same-origin",
      signal,
    });
  } catch {
    if (didTimeout()) {
      throw new TranscriptionError(
        "TRANSCRIPTION_TIMEOUT",
        "The transcript took too long to prepare. Your recording remains saved on this device.",
        true,
      );
    }
    throw new TranscriptionError(
      "TRANSCRIPTION_NETWORK_ERROR",
      "The transcript could not be prepared yet. Your recording remains saved on this device.",
      true,
    );
  }
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
}

function cachePartialResult(key: string, result: TranscriptionResult): void {
  partialResultCache.delete(key);
  partialResultCache.set(key, {
    result,
    expiresAt: Date.now() + PARTIAL_TRANSCRIPTION_CACHE_TTL_MS,
  });
  while (partialResultCache.size > MAX_CACHED_PART_RESULTS) {
    const oldest = partialResultCache.keys().next().value;
    if (!oldest) {
      break;
    }
    partialResultCache.delete(oldest);
  }
}

export function clearPartialTranscriptionCache(segmentId: string): void {
  const prefix = `${segmentId}|`;
  for (const key of partialResultCache.keys()) {
    if (key.startsWith(prefix)) {
      partialResultCache.delete(key);
    }
  }
}

async function transcribePart(
  part: TranscriptionAudioPart,
  audioDigest: string,
  segmentId: string,
  chunkIndex: number,
  chunkCount: number,
  signal: AbortSignal,
  didTimeout: () => boolean,
): Promise<TranscriptionResult> {
  let response: Response;
  try {
    response = await fetch("/api/transcriptions", {
      method: "POST",
      body: part.audio,
      credentials: "same-origin",
      headers: {
        "Content-Type": part.audio.type,
        "X-LE-Audio-Bytes": String(part.audio.size),
        "X-LE-Audio-Sha256": audioDigest,
        "X-LE-Language": "en",
        "X-LE-Part-Count": String(chunkCount),
        "X-LE-Part-Duration-Ms": String(part.durationMs),
        "X-LE-Part-Index": String(chunkIndex),
        "X-LE-Part-Start-Ms": String(part.startOffsetMs),
        "X-LE-Segment-Id": segmentId,
      },
      signal,
    });
  } catch {
    if (didTimeout()) {
      throw new TranscriptionError(
        "TRANSCRIPTION_TIMEOUT",
        "The transcript took too long to prepare. Your recording remains saved on this device.",
        true,
      );
    }
    throw new TranscriptionError(
      "TRANSCRIPTION_NETWORK_ERROR",
      "The transcript could not be prepared yet. Your recording remains saved on this device.",
      true,
    );
  }

  if (!response.ok) {
    throw await errorFromResponse(response);
  }

  const body: unknown = await response.json().catch(() => null);
  const parsed = transcriptionResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new TranscriptionError(
      "TRANSCRIPTION_RESPONSE_INVALID",
      "The transcript response was invalid. Your recording remains saved on this device.",
      false,
    );
  }
  if (
    parsed.data.uncertainties.some(
      (uncertainty) =>
        uncertainty.end > parsed.data.text.length ||
        uncertainty.audioEndMs > part.durationMs,
    )
  ) {
    throw new TranscriptionError(
      "TRANSCRIPTION_RESPONSE_INVALID",
      "The transcript response was invalid. Your recording remains saved on this device.",
      false,
    );
  }
  return parsed.data;
}

export async function transcribeRecording({
  audioParts,
  segmentId,
  durationMs,
  signal,
}: TranscriptionRequest): Promise<TranscriptionResult> {
  try {
    validateParts(audioParts, durationMs);
  } catch (error) {
    if (error instanceof TranscriptionError && !error.retryable) {
      clearPartialTranscriptionCache(segmentId);
    }
    throw error;
  }
  const deadline = segmentDeadline(signal);
  try {
    const results: TranscriptionResult[] = [];
    let browserSessionEstablished = false;
    for (const [index, part] of audioParts.entries()) {
      const audioDigest = await audioSha256(part.audio);
      const key = partialResultKey(
        segmentId,
        index + 1,
        audioDigest,
        part,
      );
      const cached = partialResultCache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        results.push(cached.result);
      } else {
        if (cached) {
          partialResultCache.delete(key);
        }
        if (!browserSessionEstablished) {
          await establishBrowserSession(
            deadline.signal,
            deadline.didTimeout,
          );
          browserSessionEstablished = true;
        }
        const result = await transcribePart(
          part,
          audioDigest,
          segmentId,
          index + 1,
          audioParts.length,
          deadline.signal,
          deadline.didTimeout,
        );
        cachePartialResult(key, result);
        results.push(result);
      }
    }

    const first = results[0];
    if (!first) {
      throw new TranscriptionError(
        "TRANSCRIPTION_RESPONSE_INVALID",
        "The transcript response was invalid. Your recording remains saved on this device.",
        false,
      );
    }
    let text = "";
    const uncertainties: TranscriptionResult["uncertainties"] = [];
    for (const [index, result] of results.entries()) {
      if (
        result.provider !== first.provider ||
        result.model !== first.model ||
        result.language !== first.language
      ) {
        throw new TranscriptionError(
          "TRANSCRIPTION_RESPONSE_INVALID",
          "The transcript response was invalid. Your recording remains saved on this device.",
          false,
        );
      }
      const separator = text.length > 0 && result.text.length > 0 ? " " : "";
      const textOffset = text.length + separator.length;
      text += `${separator}${result.text}`;
      const audioOffset = audioParts[index]!.startOffsetMs;
      uncertainties.push(
        ...result.uncertainties.map((uncertainty) => ({
          ...uncertainty,
          start: uncertainty.start + textOffset,
          end: uncertainty.end + textOffset,
          audioStartMs: uncertainty.audioStartMs + audioOffset,
          audioEndMs: uncertainty.audioEndMs + audioOffset,
        })),
      );
    }
    const combined = {
      text,
      provider: first.provider,
      model: first.model,
      language: first.language,
      uncertainties,
    };
    clearPartialTranscriptionCache(segmentId);
    return combined;
  } catch (error) {
    if (error instanceof TranscriptionError && !error.retryable) {
      clearPartialTranscriptionCache(segmentId);
    }
    throw error;
  } finally {
    deadline.dispose();
  }
}

export function wordSequence(text: string): readonly string[] {
  return (
    text
      .normalize("NFC")
      .toLocaleLowerCase("en")
      .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []
  );
}

export function isWordPreservingFormat(
  original: string,
  formatted: string,
): boolean {
  const originalWords = wordSequence(original);
  const formattedWords = wordSequence(formatted);

  return (
    originalWords.length === formattedWords.length &&
    originalWords.every((word, index) => word === formattedWords[index])
  );
}
