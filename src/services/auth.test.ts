import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  continueWithEmailMagicLink,
  completeEmailMagicLinkReturn,
  storeAuthReturnContext,
  takeAuthReturnContext,
  type AuthReturnContext,
} from "./auth";

interface SignInWithOtpRequest {
  readonly email: string;
  readonly options: {
    readonly emailRedirectTo: string;
    readonly shouldCreateUser: boolean;
  };
}

interface VerifyOtpRequest {
  readonly token_hash: string;
  readonly type: "email";
}

const mocks = vi.hoisted(() => ({
  signInWithOtp:
    vi.fn<(request: SignInWithOtpRequest) => Promise<{ error: Error | null }>>(),
  verifyOtp:
    vi.fn<(request: VerifyOtpRequest) => Promise<{ error: Error | null }>>(),
}));

vi.mock("../lib/supabase", () => ({
  requireSupabaseClient: () => ({
    auth: {
      signInWithOtp: mocks.signInWithOtp,
      verifyOtp: mocks.verifyOtp,
    },
  }),
}));

const ATTEMPT_ID = "1b3aaed2-8d55-4c67-8976-2a7ea2758a5c";
const STORY_ID = "9d4f7ef3-b8b4-42a9-b7ca-68bff1fe315e";
const context: AuthReturnContext = {
  clientStoryId: STORY_ID,
  selectionStart: 7,
  selectionEnd: 12,
};

function storedKey(): string {
  const key = localStorage.key(0);
  if (!key) {
    throw new Error("Expected a stored authentication return context.");
  }
  return key;
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  mocks.signInWithOtp.mockReset();
  mocks.signInWithOtp.mockResolvedValue({ error: null });
  mocks.verifyOtp.mockReset();
  mocks.verifyOtp.mockResolvedValue({ error: null });
});

afterEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("email magic-link authentication", () => {
  it("requests a PKCE-compatible magic link without storing the email address", async () => {
    await continueWithEmailMagicLink(" person@example.test ", context);

    expect(mocks.signInWithOtp).toHaveBeenCalledOnce();
    const request = mocks.signInWithOtp.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      email: "person@example.test",
      options: { shouldCreateUser: true },
    });
    if (!request) {
      throw new Error("Expected a passwordless email request.");
    }
    const redirectUrl = new URL(request.options.emailRedirectTo);
    expect(redirectUrl.origin).toBe(window.location.origin);
    expect(redirectUrl.pathname).toBe("/auth/confirm");
    expect(redirectUrl.searchParams.get("auth_return")).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(localStorage.getItem(storedKey())).not.toContain(
      "person@example.test",
    );
  });

  it("removes the pending return context when sending fails", async () => {
    mocks.signInWithOtp.mockResolvedValue({
      error: new Error("synthetic-send-failure"),
    });

    await expect(
      continueWithEmailMagicLink("person@example.test", context),
    ).rejects.toThrow("synthetic-send-failure");
    expect(localStorage).toHaveLength(0);
  });

  it("leaves callback context untouched in the original root tab", () => {
    storeAuthReturnContext(context, ATTEMPT_ID);
    window.history.replaceState(
      {},
      "",
      `/?auth_return=${ATTEMPT_ID}`,
    );

    expect(takeAuthReturnContext()).toBeNull();
    expect(localStorage).toHaveLength(1);
  });

  it("takes the matching callback context once in the magic-link tab", () => {
    storeAuthReturnContext(context, ATTEMPT_ID);
    window.history.replaceState(
      {},
      "",
      `/auth/confirm?auth_return=${ATTEMPT_ID}`,
    );

    expect(takeAuthReturnContext()).toEqual(context);
    expect(takeAuthReturnContext()).toBeNull();
    expect(localStorage).toHaveLength(0);
  });

  it("verifies the callback token hash and removes it from the browser URL", async () => {
    window.history.replaceState(
      {},
      "",
      `/auth/confirm?auth_return=${ATTEMPT_ID}&token_hash=synthetic-token-hash&type=email`,
    );

    await completeEmailMagicLinkReturn();

    expect(mocks.verifyOtp).toHaveBeenCalledWith({
      token_hash: "synthetic-token-hash",
      type: "email",
    });
    expect(window.location.pathname).toBe("/auth/confirm");
    expect(window.location.search).toBe(`?auth_return=${ATTEMPT_ID}`);
  });

  it("does not remove a failed or replayed callback token", async () => {
    mocks.verifyOtp.mockResolvedValue({
      error: new Error("synthetic-invalid-token"),
    });
    window.history.replaceState(
      {},
      "",
      `/auth/confirm?auth_return=${ATTEMPT_ID}&token_hash=synthetic-token-hash&type=email`,
    );

    await expect(completeEmailMagicLinkReturn()).rejects.toThrow(
      "synthetic-invalid-token",
    );
    expect(window.location.search).toContain("token_hash=");
  });

  it("rejects expired callback context without exposing it to the app", () => {
    storeAuthReturnContext(context, ATTEMPT_ID);
    const key = storedKey();
    localStorage.setItem(
      key,
      JSON.stringify({ context, expiresAt: Date.now() - 1 }),
    );
    window.history.replaceState(
      {},
      "",
      `/auth/confirm?auth_return=${ATTEMPT_ID}`,
    );

    expect(takeAuthReturnContext()).toBeNull();
    expect(localStorage).toHaveLength(0);
  });
});
