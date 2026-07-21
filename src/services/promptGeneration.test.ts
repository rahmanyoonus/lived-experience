import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateStoryPrompt,
  MAX_PROMPT_STORY_EXCERPT_CHARACTERS,
} from "./promptGeneration";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function promptResponse(
  overrides: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      prompt: "What did the fictional workshop sound like in the morning?",
      basis: "current",
      provider: "openai",
      model: "gpt-5.6-luna",
      ...overrides,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("prompt generation browser boundary", () => {
  it("establishes the browser session and sends bounded current-story context", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(promptResponse());
    vi.stubGlobal("fetch", fetchMock);
    const storyText = `start ${"x".repeat(14_000)} end`;

    await expect(
      generateStoryPrompt({
        storyText,
        previousPrompt: "What happened first?",
      }),
    ).resolves.toMatchObject({
      basis: "current",
      model: "gpt-5.6-luna",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/browser-session",
      expect.objectContaining({ method: "POST" }),
    );
    const request = fetchMock.mock.calls[1]?.[1];
    const requestBody = request?.body;
    if (typeof requestBody !== "string") {
      throw new Error("Expected prompt request body to be a string.");
    }
    const body = JSON.parse(requestBody) as {
      storyExcerpt: string;
      previousPrompt: string;
    };
    expect(body.storyExcerpt.length).toBeLessThanOrEqual(
      MAX_PROMPT_STORY_EXCERPT_CHARACTERS,
    );
    expect(body.storyExcerpt).toContain("start");
    expect(body.storyExcerpt).toContain("end");
    expect(body.previousPrompt).toBe("What happened first?");
  });

  it("maps provider failures to a calm content-free error", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "GUIDANCE_PROVIDER_ERROR",
            message:
              "A prompt isn’t available right now. Your story is unchanged.",
          }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateStoryPrompt({ storyText: "Synthetic private fixture text." }),
    ).rejects.toMatchObject({
      code: "GUIDANCE_PROVIDER_ERROR",
      retryable: true,
      message: "A prompt isn’t available right now. Your story is unchanged.",
    });
  });

  it("rejects an invalid success response without exposing its contents", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(promptResponse({ prompt: "Too short" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateStoryPrompt({ storyText: "Synthetic private fixture text." }),
    ).rejects.toMatchObject({
      code: "GUIDANCE_RESPONSE_INVALID",
      message: "A prompt isn’t available right now. Your story is unchanged.",
    });
  });
});
