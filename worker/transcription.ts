import { jsonResponse } from "./http";
import { OPENAI_TRANSCRIPTION_PROVIDER_POLICY } from "./provider-policy";
import type { SpendReservationDecision } from "./spend-gate";

const OPENAI_TRANSCRIPTIONS_URL =
  OPENAI_TRANSCRIPTION_PROVIDER_POLICY.endpoint;
const TRANSCRIPTION_MODEL = OPENAI_TRANSCRIPTION_PROVIDER_POLICY.model;
const MAX_LOGICAL_SEGMENT_DURATION_MS =
  OPENAI_TRANSCRIPTION_PROVIDER_POLICY.maxLogicalSegmentDurationMs;
const MAX_PART_DURATION_MS =
  OPENAI_TRANSCRIPTION_PROVIDER_POLICY.maxPartDurationMs;
// Browsers may rotate early when a recorder reaches its byte ceiling. The
// duration boundary remains authoritative, while this coordinated hard cap
// prevents unbounded provider calls for one logical segment.
const MAX_CHUNK_COUNT = OPENAI_TRANSCRIPTION_PROVIDER_POLICY.maxPartCount;
// OpenAI's Speech to Text guide states a 25 MB maximum file size.
// Stay below that provider boundary so multipart overhead and browser variance
// cannot turn a valid client part into an oversized upstream request.
const MAX_AUDIO_BYTES = OPENAI_TRANSCRIPTION_PROVIDER_POLICY.maxAudioBytes;
const MAX_UPSTREAM_RESPONSE_BYTES = 4 * 1024 * 1024;
export const TRANSCRIPTION_PROVIDER_TIMEOUT_MS = 10 * 60 * 1_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SUPPORTED_AUDIO_TYPES = new Map([
  ["audio/webm", "webm"],
  ["audio/mp4", "mp4"],
  ["audio/m4a", "m4a"],
  ["audio/x-m4a", "m4a"],
]);

/**
 * The model returns token log probabilities. Values below this conservative
 * boundary are surfaced as uncertain instead of being silently trusted.
 */
export const LOW_CONFIDENCE_LOGPROB_THRESHOLD = -1;

export type UpstreamFetch = typeof fetch;

interface TranscriptionInput {
  readonly audio: ReadableStream<Uint8Array>;
  readonly audioByteSize: number;
  readonly audioSha256: string;
  readonly durationMs: number;
  readonly mediaType: string;
  readonly segmentId: string;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly chunkStartMs: number;
}

export interface LogicalSegmentReservationInput {
  readonly segmentId: string;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly chunkStartMs: number;
  readonly durationMs: number;
  readonly audioSha256: string;
}

export interface TranscriptionAdmission {
  readonly response: Response | null;
  readonly release?: () => Promise<void>;
}

export type ReserveLogicalSegment = (
  input: LogicalSegmentReservationInput,
) => Promise<TranscriptionAdmission>;

export interface TranscriptionSpendAccounting {
  readonly reserve: (input: {
    readonly durationMs: number;
  }) => Promise<SpendReservationDecision>;
  readonly reconcile: (
    reservationId: string,
    responseBody: unknown,
  ) => Promise<void>;
}

interface TranscriptionLogprob {
  readonly token: string;
  readonly bytes: readonly number[];
  readonly logprob: number;
}

interface OpenAITranscriptionResponse {
  readonly text: string;
  readonly logprobs: readonly TranscriptionLogprob[];
}

interface TranscriptionUncertainty {
  readonly start: number;
  readonly end: number;
  readonly audioStartMs: number;
  readonly audioEndMs: number;
  readonly confidence?: number;
}

class PublicTranscriptionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "PublicTranscriptionError";
    this.status = status;
    this.code = code;
  }
}

function publicErrorResponse(error: PublicTranscriptionError): Response {
  return jsonResponse(
    { code: error.code, message: error.message },
    { status: error.status },
  );
}

function invalidRequest(
  code = "TRANSCRIPTION_REQUEST_INVALID",
): PublicTranscriptionError {
  return new PublicTranscriptionError(
    400,
    code,
    "The recording request was invalid. The recording remains saved on this device.",
  );
}

function mediaTypeWithoutParameters(mediaType: string): string {
  return (mediaType.split(";", 1)[0] ?? "").trim().toLowerCase();
}

function parseContentLength(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  if (!/^\d+$/.test(value)) {
    throw invalidRequest("TRANSCRIPTION_CONTENT_LENGTH_INVALID");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw invalidRequest("TRANSCRIPTION_CONTENT_LENGTH_INVALID");
  }
  return parsed;
}

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name)?.trim();
  if (!value || value.includes(",")) {
    throw invalidRequest("TRANSCRIPTION_METADATA_INVALID");
  }
  return value;
}

function unsignedIntegerHeader(request: Request, name: string): number {
  const value = requiredHeader(request, name);
  if (!/^\d+$/.test(value)) {
    throw invalidRequest("TRANSCRIPTION_METADATA_INVALID");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw invalidRequest("TRANSCRIPTION_METADATA_INVALID");
  }
  return parsed;
}

async function readBodyWithinLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<ArrayBuffer> {
  if (!body) {
    return new ArrayBuffer(0);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    totalBytes += result.value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new PublicTranscriptionError(
        413,
        "TRANSCRIPTION_AUDIO_TOO_LARGE",
        "This recording part is too large to transcribe. It remains saved on this device.",
      );
    }
    chunks.push(result.value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

function parseTranscriptionInput(
  request: Request<unknown, IncomingRequestCfProperties<unknown>>,
): TranscriptionInput {
  const contentType = request.headers.get("Content-Type") ?? "";
  const mediaType = mediaTypeWithoutParameters(contentType);
  if (!SUPPORTED_AUDIO_TYPES.has(mediaType)) {
    throw new PublicTranscriptionError(
      415,
      "TRANSCRIPTION_AUDIO_TYPE_UNSUPPORTED",
      "The recording request must use a supported upload format. The recording remains saved on this device.",
    );
  }
  const audio = request.body;
  if (!audio) {
    throw invalidRequest("TRANSCRIPTION_AUDIO_REQUIRED");
  }
  const language = requiredHeader(request, "X-LE-Language");
  if (language !== "en") {
    throw new PublicTranscriptionError(
      422,
      "TRANSCRIPTION_LANGUAGE_UNSUPPORTED",
      "Only English transcription is available in this version. The recording remains saved on this device.",
    );
  }
  const segmentId = requiredHeader(request, "X-LE-Segment-Id");
  if (!UUID.test(segmentId)) {
    throw invalidRequest("TRANSCRIPTION_SEGMENT_ID_INVALID");
  }
  const durationMs = unsignedIntegerHeader(request, "X-LE-Part-Duration-Ms");
  const chunkCount = unsignedIntegerHeader(request, "X-LE-Part-Count");
  const chunkIndex = unsignedIntegerHeader(request, "X-LE-Part-Index");
  const chunkStartMs = unsignedIntegerHeader(request, "X-LE-Part-Start-Ms");
  const audioByteSize = unsignedIntegerHeader(request, "X-LE-Audio-Bytes");
  const audioSha256 = requiredHeader(request, "X-LE-Audio-Sha256").toLowerCase();
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1 ||
    durationMs > MAX_PART_DURATION_MS ||
    !Number.isSafeInteger(chunkCount) ||
    chunkCount < 1 ||
    chunkCount > MAX_CHUNK_COUNT ||
    !Number.isSafeInteger(chunkIndex) ||
    chunkIndex < 1 ||
    chunkIndex > chunkCount ||
    !Number.isSafeInteger(chunkStartMs) ||
    chunkStartMs < 0 ||
    (chunkIndex === 1 && chunkStartMs !== 0) ||
    (chunkIndex > 1 && chunkStartMs < 1) ||
    chunkStartMs > (chunkIndex - 1) * MAX_PART_DURATION_MS ||
    chunkStartMs + durationMs > MAX_LOGICAL_SEGMENT_DURATION_MS ||
    chunkStartMs + durationMs + (chunkCount - chunkIndex) >
      MAX_LOGICAL_SEGMENT_DURATION_MS
  ) {
    throw new PublicTranscriptionError(
      422,
      "TRANSCRIPTION_CHUNK_INVALID",
      "This recording part is not supported. The recording remains saved on this device.",
    );
  }
  if (audioByteSize < 1) {
    throw invalidRequest("TRANSCRIPTION_AUDIO_EMPTY");
  }
  if (audioByteSize > MAX_AUDIO_BYTES) {
    throw new PublicTranscriptionError(
      413,
      "TRANSCRIPTION_AUDIO_TOO_LARGE",
      "This recording part is too large to transcribe. It remains saved on this device.",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(audioSha256)) {
    throw invalidRequest("TRANSCRIPTION_AUDIO_DIGEST_INVALID");
  }
  const contentLength = parseContentLength(
    request.headers.get("Content-Length"),
  );
  if (contentLength !== null && contentLength !== audioByteSize) {
    throw invalidRequest("TRANSCRIPTION_CONTENT_LENGTH_INVALID");
  }

  return {
    audio,
    audioByteSize,
    audioSha256,
    durationMs,
    mediaType,
    segmentId,
    chunkIndex,
    chunkCount,
    chunkStartMs,
  };
}

interface OpenAIMultipartRequest {
  readonly body: ReadableStream<Uint8Array>;
  readonly contentType: string;
  readonly inputError: () => PublicTranscriptionError | null;
}

function openAIMultipartRequest(
  input: TranscriptionInput,
): OpenAIMultipartRequest {
  const boundary = `----lived-experience-${crypto.randomUUID().replaceAll("-", "")}`;
  const encoder = new TextEncoder();
  const extension = SUPPORTED_AUDIO_TYPES.get(input.mediaType);
  if (!extension) {
    throw invalidRequest();
  }
  const prefix = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${input.segmentId}-${input.chunkIndex}-of-${input.chunkCount}.${extension}"\r\n` +
      `Content-Type: ${input.mediaType}\r\n\r\n`,
  );
  const fields = [
    ["model", TRANSCRIPTION_MODEL],
    ["language", "en"],
    ["response_format", "json"],
    ["stream", "false"],
    ["temperature", "0"],
    [
      "prompt",
      "Transcribe faithfully in English. Preserve filler words, repetitions, false starts, vocabulary, and meaning. Add only punctuation, capitalisation, and paragraph breaks. Do not rewrite or summarise.",
    ],
    ["include[]", "logprobs"],
  ] as const;
  const suffix = encoder.encode(
    `${fields
      .map(
        ([name, value]) =>
          `\r\n--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n${value}`,
      )
      .join("")}\r\n--${boundary}--\r\n`,
  );
  const reader = input.audio.getReader();
  const workerCrypto = crypto as Crypto & {
    readonly DigestStream: typeof DigestStream;
  };
  const digestStream = new workerCrypto.DigestStream("SHA-256");
  const digestResult = digestStream.digest.then(
    (digest) => ({ ok: true as const, digest }),
    () => ({ ok: false as const }),
  );
  const digestWriter = digestStream.getWriter();
  let bytesRead = 0;
  let finished = false;
  let inputError: PublicTranscriptionError | null = null;

  const failInput = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    error: PublicTranscriptionError,
  ) => {
    finished = true;
    inputError = error;
    controller.error(error);
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(prefix);
    },
    async pull(controller) {
      if (finished) {
        return;
      }
      const next = await reader.read();
      if (next.done) {
        if (bytesRead !== input.audioByteSize) {
          await digestWriter.abort().catch(() => undefined);
          failInput(
            controller,
            invalidRequest("TRANSCRIPTION_AUDIO_SIZE_INVALID"),
          );
          return;
        }
        await digestWriter.close();
        const settledDigest = await digestResult;
        if (!settledDigest.ok) {
          failInput(
            controller,
            invalidRequest("TRANSCRIPTION_AUDIO_DIGEST_INVALID"),
          );
          return;
        }
        const actualDigest = Array.from(
          new Uint8Array(settledDigest.digest),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        if (actualDigest !== input.audioSha256) {
          failInput(
            controller,
            invalidRequest("TRANSCRIPTION_AUDIO_DIGEST_INVALID"),
          );
          return;
        }
        finished = true;
        controller.enqueue(suffix);
        controller.close();
        return;
      }
      bytesRead += next.value.byteLength;
      if (
        bytesRead > input.audioByteSize ||
        bytesRead > MAX_AUDIO_BYTES
      ) {
        await reader.cancel();
        await digestWriter.abort().catch(() => undefined);
        failInput(
          controller,
          new PublicTranscriptionError(
            413,
            "TRANSCRIPTION_AUDIO_TOO_LARGE",
            "This recording part is too large to transcribe. It remains saved on this device.",
          ),
        );
        return;
      }
      await digestWriter.write(next.value);
      controller.enqueue(next.value);
    },
    async cancel(reason) {
      finished = true;
      await Promise.allSettled([
        reader.cancel(reason),
        digestWriter.abort(reason),
      ]);
    },
  });

  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
    inputError: () => inputError,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseOpenAITranscriptionResponse(
  value: unknown,
): OpenAITranscriptionResponse {
  if (!isRecord(value) || typeof value.text !== "string") {
    throw new Error("OpenAI returned an invalid transcription response.");
  }

  // OpenAI omits logprobs when a valid transcription contains no speech.
  // Keep requiring confidence data whenever there is transcript text so the
  // uncertainty review path cannot be bypassed by a malformed response.
  if (
    value.text.length === 0 &&
    (value.logprobs === undefined || value.logprobs === null)
  ) {
    return { text: value.text, logprobs: [] };
  }
  if (!Array.isArray(value.logprobs)) {
    throw new Error("OpenAI returned an invalid transcription response.");
  }

  const logprobs: TranscriptionLogprob[] = [];
  for (const candidate of value.logprobs) {
    if (
      !isRecord(candidate) ||
      typeof candidate.token !== "string" ||
      !Array.isArray(candidate.bytes) ||
      !candidate.bytes.every(
        (byte) =>
          Number.isSafeInteger(byte) &&
          typeof byte === "number" &&
          byte >= 0 &&
          byte <= 255,
      ) ||
      !isFiniteNumber(candidate.logprob)
    ) {
      throw new Error("OpenAI returned invalid transcription logprobs.");
    }
    logprobs.push({
      token: candidate.token,
      bytes: candidate.bytes,
      logprob: candidate.logprob,
    });
  }

  return { text: value.text, logprobs };
}

function mapUncertainties(
  text: string,
  logprobs: readonly TranscriptionLogprob[],
  partDurationMs: number,
): readonly TranscriptionUncertainty[] {
  const wholePartFallback = (): readonly TranscriptionUncertainty[] => {
    const lowConfidenceTokens = logprobs.filter(
      (token) =>
        token.token.trim().length > 0 &&
        token.logprob < LOW_CONFIDENCE_LOGPROB_THRESHOLD,
    );
    if (lowConfidenceTokens.length === 0 || text.trim().length === 0) {
      return [];
    }
    return [
      {
        start: 0,
        end: text.length,
        // A token/text mismatch makes word offsets unsafe. Link the complete
        // returned text to the complete immutable part instead of guessing.
        audioStartMs: 0,
        audioEndMs: partDurationMs,
        confidence: Math.min(
          ...lowConfidenceTokens.map((token) =>
            Math.max(0, Math.min(1, Math.exp(token.logprob))),
          ),
        ),
      },
    ];
  };
  const uncertainties: TranscriptionUncertainty[] = [];
  let cursor = 0;
  let lowConfidenceRunOpen = false;

  for (const token of logprobs) {
    if (text.slice(cursor, cursor + token.token.length) !== token.token) {
      // Do not infer word offsets when the returned text and token stream
      // differ. A known low-confidence result still gets an honest part-level
      // review path.
      return wholePartFallback();
    }
    const tokenStart = cursor;
    cursor += token.token.length;

    if (token.token.trim().length === 0) {
      continue;
    }

    if (token.logprob >= LOW_CONFIDENCE_LOGPROB_THRESHOLD) {
      lowConfidenceRunOpen = false;
      continue;
    }

    const leadingWhitespace = token.token.length - token.token.trimStart().length;
    const trailingWhitespace = token.token.length - token.token.trimEnd().length;
    const start = tokenStart + leadingWhitespace;
    const end = cursor - trailingWhitespace;

    const uncertainty: TranscriptionUncertainty = {
      start,
      end,
      // Token logprobs do not include timestamps. Link uncertainty to the
      // uploaded part; the client adds chunkStartMs exactly once.
      audioStartMs: 0,
      audioEndMs: partDurationMs,
      confidence: Math.max(0, Math.min(1, Math.exp(token.logprob))),
    };

    const previous = uncertainties.at(-1);
    if (lowConfidenceRunOpen && previous) {
      uncertainties[uncertainties.length - 1] = {
        ...previous,
        end: uncertainty.end,
        confidence: Math.min(
          previous.confidence ?? 1,
          uncertainty.confidence ?? 1,
        ),
      };
    } else {
      uncertainties.push(uncertainty);
    }
    lowConfidenceRunOpen = true;
  }

  if (cursor !== text.length) {
    return wholePartFallback();
  }
  return uncertainties;
}

async function readResponseJson(response: Response): Promise<unknown> {
  const contentLength = parseContentLength(
    response.headers.get("Content-Length"),
  );
  if (
    contentLength !== null &&
    contentLength > MAX_UPSTREAM_RESPONSE_BYTES
  ) {
    if (response.body) {
      await response.body.cancel();
    }
    throw new Error("OpenAI response exceeded the safe limit.");
  }

  const bytes = await readBodyWithinLimit(
    response.body,
    MAX_UPSTREAM_RESPONSE_BYTES,
  );
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function upstreamErrorResponse(status: number): Response {
  if (status === 429) {
    return jsonResponse(
      {
        code: "TRANSCRIPTION_PROVIDER_BUSY",
        message:
          "The transcript service is busy. Your recording remains saved on this device.",
      },
      { status: 429 },
    );
  }
  if (status === 401) {
    return jsonResponse(
      {
        code: "TRANSCRIPTION_PROVIDER_AUTH_FAILED",
        message:
          "Transcription is not available yet. Your recording remains saved on this device.",
      },
      { status: 503 },
    );
  }
  if (status === 403) {
    return jsonResponse(
      {
        code: "TRANSCRIPTION_PROVIDER_ACCESS_DENIED",
        message:
          "Transcription is not available yet. Your recording remains saved on this device.",
      },
      { status: 503 },
    );
  }
  return jsonResponse(
    {
      code: "TRANSCRIPTION_PROVIDER_ERROR",
      message:
        "The transcript could not be prepared yet. Your recording remains saved on this device.",
    },
    { status: 502 },
  );
}

export async function handleTranscription(
  request: Request<unknown, IncomingRequestCfProperties<unknown>>,
  apiKey: string | undefined,
  upstreamFetch: UpstreamFetch,
  reserveLogicalSegment?: ReserveLogicalSegment,
  spendAccounting?: TranscriptionSpendAccounting,
  providerTimeoutMs = TRANSCRIPTION_PROVIDER_TIMEOUT_MS,
): Promise<Response> {
  if (!apiKey?.trim()) {
    return jsonResponse(
      {
        code: "TRANSCRIPTION_PROVIDER_UNCONFIGURED",
        message:
          "Transcription is not connected yet. The recording remains saved on this device.",
      },
      { status: 503 },
    );
  }

  let input: TranscriptionInput;
  try {
    input = parseTranscriptionInput(request);
  } catch (error) {
    if (error instanceof PublicTranscriptionError) {
      return publicErrorResponse(error);
    }
    return publicErrorResponse(invalidRequest());
  }

  let releaseUnusedAttempt: (() => Promise<void>) | undefined;
  if (reserveLogicalSegment) {
    const admission = await reserveLogicalSegment({
      segmentId: input.segmentId,
      chunkIndex: input.chunkIndex,
      chunkCount: input.chunkCount,
      chunkStartMs: input.chunkStartMs,
      durationMs: input.durationMs,
      audioSha256: input.audioSha256,
    });
    if (admission.response) {
      return admission.response;
    }
    releaseUnusedAttempt = admission.release;
  }

  async function releaseAdmissionBeforeProvider(): Promise<void> {
    const release = releaseUnusedAttempt;
    releaseUnusedAttempt = undefined;
    if (release) {
      await release().catch(() => undefined);
    }
  }

  let spendReservationId: string | undefined;
  if (spendAccounting) {
    let spendDecision: SpendReservationDecision;
    try {
      spendDecision = await spendAccounting.reserve({
        // Media duration is not independently parseable at this streaming
        // boundary. Reserve every admitted call at the full part limit so a
        // forged short-duration header cannot weaken the hard cost gate.
        durationMs: MAX_PART_DURATION_MS,
      });
    } catch {
      await releaseAdmissionBeforeProvider();
      return jsonResponse(
        {
          code: "TRANSCRIPTION_GUARD_UNAVAILABLE",
          message:
            "Transcription is not available yet. Your recording remains saved on this device.",
        },
        { status: 503 },
      );
    }
    if (!spendDecision.allowed) {
      await releaseAdmissionBeforeProvider();
      return jsonResponse(
        {
          code: "TRANSCRIPTION_BUDGET_REACHED",
          message:
            "Transcription is temporarily unavailable. Your recording remains saved on this device.",
        },
        {
          status: 503,
          headers: {
            "Retry-After": String(spendDecision.retryAfterSeconds ?? 1),
          },
        },
      );
    }
    if (!spendDecision.reservationId) {
      await releaseAdmissionBeforeProvider();
      return jsonResponse(
        {
          code: "TRANSCRIPTION_GUARD_UNAVAILABLE",
          message:
            "Transcription is not available yet. Your recording remains saved on this device.",
        },
        { status: 503 },
      );
    }
    spendReservationId = spendDecision.reservationId;
  }

  let upstreamRequest: OpenAIMultipartRequest;
  try {
    upstreamRequest = openAIMultipartRequest(input);
  } catch {
    await releaseAdmissionBeforeProvider();
    return publicErrorResponse(invalidRequest());
  }

  let upstreamResponse: Response;
  const timeoutSignal = AbortSignal.timeout(providerTimeoutMs);
  try {
    upstreamResponse = await upstreamFetch(OPENAI_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "Content-Type": upstreamRequest.contentType,
      },
      body: upstreamRequest.body,
      signal: AbortSignal.any([request.signal, timeoutSignal]),
    });
  } catch {
    const inputValidationError = upstreamRequest.inputError();
    if (inputValidationError) {
      return publicErrorResponse(inputValidationError);
    }
    if (timeoutSignal.aborted && !request.signal.aborted) {
      return jsonResponse(
        {
          code: "TRANSCRIPTION_PROVIDER_TIMEOUT",
          message:
            "The transcript took too long to prepare. Your recording remains saved on this device.",
        },
        { status: 504 },
      );
    }
    return upstreamErrorResponse(502);
  }

  if (!upstreamResponse.ok) {
    if (upstreamResponse.body) {
      await upstreamResponse.body.cancel();
    }
    return upstreamErrorResponse(upstreamResponse.status);
  }

  try {
    const body = await readResponseJson(upstreamResponse);
    if (spendAccounting && spendReservationId) {
      try {
        await spendAccounting.reconcile(spendReservationId, body);
      } catch {
        // Retain the conservative reservation when reconciliation is unknown.
      }
    }
    const transcription = parseOpenAITranscriptionResponse(body);
    return jsonResponse({
      text: transcription.text,
      provider: "openai",
      model: TRANSCRIPTION_MODEL,
      language: "en",
      uncertainties: mapUncertainties(
        transcription.text,
        transcription.logprobs,
        input.durationMs,
      ),
    });
  } catch {
    if (timeoutSignal.aborted && !request.signal.aborted) {
      return jsonResponse(
        {
          code: "TRANSCRIPTION_PROVIDER_TIMEOUT",
          message:
            "The transcript took too long to prepare. Your recording remains saved on this device.",
        },
        { status: 504 },
      );
    }
    return jsonResponse(
      {
        code: "TRANSCRIPTION_PROVIDER_RESPONSE_INVALID",
        message:
          "The transcript response was invalid. Your recording remains saved on this device.",
      },
      { status: 502 },
    );
  }
}
