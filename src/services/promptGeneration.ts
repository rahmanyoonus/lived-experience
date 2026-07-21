import { z } from "zod";

export const PROMPT_GENERATION_TIMEOUT_MS = 35_000;
export const MAX_PROMPT_STORY_EXCERPT_CHARACTERS = 12_000;

const promptResponseSchema = z.object({
  prompt: z.string().min(12).max(240),
  basis: z.enum(["current", "general"]),
  provider: z.string().min(1),
  model: z.string().min(1),
});

const promptErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});

export interface PromptGenerationRequest {
  readonly storyText: string;
  readonly previousPrompt?: string | null;
  readonly signal?: AbortSignal;
}

export interface PromptGenerationResult {
  readonly prompt: string;
  readonly basis: "current" | "general";
  readonly provider: string;
  readonly model: string;
}

export class PromptGenerationError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "PromptGenerationError";
    this.code = code;
    this.retryable = retryable;
  }
}

function boundedStoryExcerpt(storyText: string): string {
  if (storyText.length <= MAX_PROMPT_STORY_EXCERPT_CHARACTERS) {
    return storyText;
  }
  const marker = "\n[…middle omitted…]\n";
  const availableCharacters =
    MAX_PROMPT_STORY_EXCERPT_CHARACTERS - marker.length;
  const startCharacters = Math.floor(availableCharacters / 2);
  const endCharacters = availableCharacters - startCharacters;
  return `${storyText.slice(0, startCharacters)}${marker}${storyText.slice(
    storyText.length - endCharacters,
  )}`;
}

function promptDeadline(externalSignal?: AbortSignal): {
  readonly signal: AbortSignal;
  readonly didTimeout: () => boolean;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, PROMPT_GENERATION_TIMEOUT_MS);
  const abortFromExternal = () => controller.abort();
  externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  if (externalSignal?.aborted) {
    controller.abort();
  }
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      window.clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
  };
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function errorFromResponse(
  response: Response,
): Promise<PromptGenerationError> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = promptErrorSchema.safeParse(body);
  return new PromptGenerationError(
    parsed.success && parsed.data.code
      ? parsed.data.code
      : "GUIDANCE_FAILED",
    parsed.success && parsed.data.message
      ? parsed.data.message
      : "A prompt isn’t available right now. Your story is unchanged.",
    retryableStatus(response.status),
  );
}

async function establishBrowserSession(signal: AbortSignal): Promise<void> {
  const response = await fetch("/api/browser-session", {
    method: "POST",
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
}

export async function generateStoryPrompt({
  storyText,
  previousPrompt = null,
  signal: externalSignal,
}: PromptGenerationRequest): Promise<PromptGenerationResult> {
  const deadline = promptDeadline(externalSignal);
  try {
    await establishBrowserSession(deadline.signal);
    const response = await fetch("/api/prompts", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        storyExcerpt: boundedStoryExcerpt(storyText),
        previousPrompt:
          previousPrompt?.slice(0, 240).trim() || null,
      }),
      signal: deadline.signal,
    });
    if (!response.ok) {
      throw await errorFromResponse(response);
    }
    const body: unknown = await response.json().catch(() => null);
    const parsed = promptResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new PromptGenerationError(
        "GUIDANCE_RESPONSE_INVALID",
        "A prompt isn’t available right now. Your story is unchanged.",
        false,
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof PromptGenerationError) {
      throw error;
    }
    if (externalSignal?.aborted) {
      throw new DOMException("Prompt generation was cancelled.", "AbortError");
    }
    throw new PromptGenerationError(
      deadline.didTimeout()
        ? "GUIDANCE_TIMEOUT"
        : "GUIDANCE_NETWORK_ERROR",
      "A prompt isn’t available right now. Your story is unchanged.",
      true,
    );
  } finally {
    deadline.dispose();
  }
}
