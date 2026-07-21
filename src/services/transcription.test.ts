import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isWordPreservingFormat,
  PARTIAL_TRANSCRIPTION_CACHE_TTL_MS,
  transcribeRecording,
  wordSequence,
} from "./transcription";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function requestTarget(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function fetchWithTranscriptionResponses(
  responses: readonly Response[],
) {
  let responseIndex = 0;
  return vi.fn<typeof fetch>((input) => {
    if (requestTarget(input) === "/api/transcription-session") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    const response = responses[responseIndex];
    responseIndex += 1;
    if (!response) {
      return Promise.reject(new Error("Unexpected transcription request."));
    }
    return Promise.resolve(response);
  });
}

function audioUploadCalls(
  fetchMock: ReturnType<typeof fetchWithTranscriptionResponses>,
) {
  return fetchMock.mock.calls.filter(
    ([input]) => requestTarget(input) === "/api/transcriptions",
  );
}

describe("transcript transformation boundary", () => {
  it("allows punctuation, capitalisation, and paragraph breaks", () => {
    const original = "um i remember that day\nit was raining";
    const formatted = "Um, I remember that day.\n\nIt was raining.";

    expect(isWordPreservingFormat(original, formatted)).toBe(true);
  });

  it("rejects removed fillers, replacements, and added words", () => {
    expect(isWordPreservingFormat("um it was hard", "It was hard.")).toBe(false);
    expect(isWordPreservingFormat("it was hard", "It was difficult.")).toBe(false);
    expect(isWordPreservingFormat("it was hard", "It was very hard.")).toBe(false);
  });

  it("preserves Unicode words and apostrophes", () => {
    expect(wordSequence("Café, Aisyah’s story")).toEqual([
      "café",
      "aisyah’s",
      "story",
    ]);
  });
});

describe("streamed transcription orchestration", () => {
  it("sends standalone parts sequentially and offsets merged uncertainty", async () => {
    const fetchMock = fetchWithTranscriptionResponses([
      Response.json({
        text: "Um, the fictional ferry left.",
        provider: "openai",
        model: "gpt-4o-mini-transcribe",
        language: "en",
        uncertainties: [
          {
            start: 8,
            end: 17,
            audioStartMs: 0,
            audioEndMs: 1_000,
          },
        ],
      }),
      Response.json({
        text: "I waited by the blue gate.",
        provider: "openai",
        model: "gpt-4o-mini-transcribe",
        language: "en",
        uncertainties: [
          {
            start: 16,
            end: 20,
            audioStartMs: 0,
            audioEndMs: 1_200,
          },
        ],
      }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const segmentId = crypto.randomUUID();
    const result = await transcribeRecording({
      segmentId,
      durationMs: 2_200,
      audioParts: [
        {
          audio: new Blob(["standalone-one"], { type: "audio/webm" }),
          durationMs: 1_000,
          startOffsetMs: 0,
        },
        {
          audio: new Blob(["standalone-two"], { type: "audio/webm" }),
          durationMs: 1_200,
          startOffsetMs: 1_000,
        },
      ],
    });

    expect(result.text).toBe(
      "Um, the fictional ferry left. I waited by the blue gate.",
    );
    expect(result.uncertainties).toEqual([
      {
        start: 8,
        end: 17,
        audioStartMs: 0,
        audioEndMs: 1_000,
      },
      {
        start: 46,
        end: 50,
        audioStartMs: 1_000,
        audioEndMs: 2_200,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/transcription-session");
    const uploads = audioUploadCalls(fetchMock);
    expect(uploads).toHaveLength(2);
    const firstBody = uploads[0]?.[1]?.body;
    const secondBody = uploads[1]?.[1]?.body;
    const firstHeaders = new Headers(uploads[0]?.[1]?.headers);
    const secondHeaders = new Headers(uploads[1]?.[1]?.headers);
    expect(firstBody).toBeInstanceOf(Blob);
    expect(secondBody).toBeInstanceOf(Blob);
    expect(firstHeaders.get("Content-Type")).toBe("audio/webm");
    expect(firstHeaders.get("X-LE-Part-Index")).toBe("1");
    expect(firstHeaders.get("X-LE-Part-Count")).toBe("2");
    expect(firstHeaders.get("X-LE-Part-Start-Ms")).toBe("0");
    expect(firstHeaders.get("X-LE-Audio-Bytes")).toBe("14");
    expect(firstHeaders.get("X-LE-Audio-Sha256")).toBe(
      "8e732969a20be6e6ffb0e363786d996a2ac0e6f69d3b68a67831bd9db383bb3d",
    );
    expect(secondHeaders.get("X-LE-Part-Index")).toBe("2");
    expect(secondHeaders.get("X-LE-Part-Start-Ms")).toBe("1000");
  });

  it("resumes at a failed part on a same-tab retry", async () => {
    const successfulPart = {
      text: "A fictional green boat waited.",
      provider: "openai",
      model: "gpt-4o-mini-transcribe",
      language: "en",
      uncertainties: [],
    };
    const fetchMock = fetchWithTranscriptionResponses([
      Response.json(successfulPart),
      Response.json(
        { code: "TRANSCRIPTION_PROVIDER_ERROR", message: "Try again." },
        { status: 503 },
      ),
      Response.json({
        ...successfulPart,
        text: "Then a yellow kite appeared.",
      }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const request = {
      segmentId: crypto.randomUUID(),
      durationMs: 2_000,
      audioParts: [
        {
          audio: new Blob(["resume-one"], { type: "audio/webm" }),
          durationMs: 1_000,
          startOffsetMs: 0,
        },
        {
          audio: new Blob(["resume-two"], { type: "audio/webm" }),
          durationMs: 1_000,
          startOffsetMs: 1_000,
        },
      ],
    } as const;

    await expect(transcribeRecording(request)).rejects.toMatchObject({
      code: "TRANSCRIPTION_PROVIDER_ERROR",
    });
    await expect(transcribeRecording(request)).resolves.toMatchObject({
      text: "A fictional green boat waited. Then a yellow kite appeared.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const uploads = audioUploadCalls(fetchMock);
    expect(uploads).toHaveLength(3);
    expect(new Headers(uploads[2]?.[1]?.headers).get("X-LE-Part-Index")).toBe(
      "2",
    );
  });

  it("does not reuse a cached result for different audio bytes", async () => {
    const firstPart = {
      text: "The fictional bell was blue.",
      provider: "openai",
      model: "gpt-4o-mini-transcribe",
      language: "en",
      uncertainties: [],
    };
    const fetchMock = fetchWithTranscriptionResponses([
      Response.json(firstPart),
      Response.json(
        { code: "TEMPORARY", message: "Try again." },
        { status: 503 },
      ),
      Response.json({
        ...firstPart,
        text: "The fictional bell was green.",
      }),
      Response.json({ ...firstPart, text: "Then it rang twice." }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const segmentId = crypto.randomUUID();
    await expect(
      transcribeRecording({
        segmentId,
        durationMs: 2_000,
        audioParts: [
          {
            audio: new Blob(["first-audio-bytes"], { type: "audio/webm" }),
            durationMs: 1_000,
            startOffsetMs: 0,
          },
          {
            audio: new Blob(["failed-second-part"], { type: "audio/webm" }),
            durationMs: 1_000,
            startOffsetMs: 1_000,
          },
        ],
      }),
    ).rejects.toMatchObject({ retryable: true });

    await expect(
      transcribeRecording({
        segmentId,
        durationMs: 2_000,
        audioParts: [
          {
            audio: new Blob(["different-audio-bytes"], { type: "audio/webm" }),
            durationMs: 1_000,
            startOffsetMs: 0,
          },
          {
            audio: new Blob(["failed-second-part"], { type: "audio/webm" }),
            durationMs: 1_000,
            startOffsetMs: 1_000,
          },
        ],
      }),
    ).resolves.toMatchObject({
      text: "The fictional bell was green. Then it rang twice.",
    });
    expect(audioUploadCalls(fetchMock)).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("expires a partial result after the short retry window", async () => {
    vi.useFakeTimers();
    const response = {
      text: "A fictional silver clock ticked.",
      provider: "openai",
      model: "gpt-4o-mini-transcribe",
      language: "en",
      uncertainties: [],
    };
    const fetchMock = fetchWithTranscriptionResponses([
      Response.json(response),
      Response.json(
        { code: "TEMPORARY", message: "Try again." },
        { status: 503 },
      ),
      Response.json(response),
      Response.json({ ...response, text: "Then it stopped." }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const request = {
      segmentId: crypto.randomUUID(),
      durationMs: 2_000,
      audioParts: [
        {
          audio: new Blob(["ttl-part-one"], { type: "audio/webm" }),
          durationMs: 1_000,
          startOffsetMs: 0,
        },
        {
          audio: new Blob(["ttl-part-two"], { type: "audio/webm" }),
          durationMs: 1_000,
          startOffsetMs: 1_000,
        },
      ],
    } as const;

    await expect(transcribeRecording(request)).rejects.toMatchObject({
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(PARTIAL_TRANSCRIPTION_CACHE_TTL_MS + 1);
    await expect(transcribeRecording(request)).resolves.toMatchObject({
      text: "A fictional silver clock ticked. Then it stopped.",
    });
    expect(audioUploadCalls(fetchMock)).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("fails closed before upload when the audio digest is unavailable", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", {});

    await expect(
      transcribeRecording({
        segmentId: "00000000-0000-4000-8000-000000000001",
        durationMs: 1_000,
        audioParts: [
          {
            audio: new Blob(["synthetic-digest-check"], {
              type: "audio/webm",
            }),
            durationMs: 1_000,
            startOffsetMs: 0,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "TRANSCRIPTION_DIGEST_UNAVAILABLE",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses one ten-minute deadline for the logical segment", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        if (requestTarget(input) === "/api/transcription-session") {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException("Synthetic abort", "AbortError"));
            return;
          }
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Synthetic abort", "AbortError")),
            { once: true },
          );
        });
      }),
    );
    const transcription = transcribeRecording({
      segmentId: crypto.randomUUID(),
      durationMs: 1_000,
      audioParts: [
        {
          audio: new Blob(["timeout-part"], { type: "audio/webm" }),
          durationMs: 1_000,
          startOffsetMs: 0,
        },
      ],
    });

    const rejection = expect(transcription).rejects.toMatchObject({
      code: "TRANSCRIPTION_TIMEOUT",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
    await rejection;
  });
});
