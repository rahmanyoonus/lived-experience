import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  requestEmailOtp,
  storeAuthReturnContext,
  takeAuthReturnContext,
  verifyEmailOtp,
  type AuthReturnContext,
} from "./auth";

interface SignInWithOtpRequest {
  readonly email: string;
  readonly options: {
    readonly shouldCreateUser: boolean;
  };
}

interface VerifyOtpRequest {
  readonly email: string;
  readonly token: string;
  readonly type: "email";
}

const mocks = vi.hoisted(() => ({
  signInWithOtp:
    vi.fn<(request: SignInWithOtpRequest) => Promise<{ error: Error | null }>>(),
  verifyOtp: vi.fn<
    (request: VerifyOtpRequest) => Promise<{
      data: { session: null };
      error: Error | null;
    }>
  >(),
}));

vi.mock("../lib/supabase", () => ({
  requireSupabaseClient: () => ({
    auth: {
      signInWithOtp: mocks.signInWithOtp,
      verifyOtp: mocks.verifyOtp,
    },
  }),
}));

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
  mocks.signInWithOtp.mockReset();
  mocks.signInWithOtp.mockResolvedValue({ error: null });
  mocks.verifyOtp.mockReset();
  mocks.verifyOtp.mockResolvedValue({ data: { session: null }, error: null });
});

afterEach(() => {
  localStorage.clear();
});

describe("email OTP authentication", () => {
  it("requests an OTP without a redirect or stored email address", async () => {
    await requestEmailOtp(" person@example.test ", context);

    expect(mocks.signInWithOtp).toHaveBeenCalledWith({
      email: "person@example.test",
      options: { shouldCreateUser: true },
    });
    expect(localStorage.getItem(storedKey())).not.toContain(
      "person@example.test",
    );
  });

  it("removes the pending story context when sending fails", async () => {
    mocks.signInWithOtp.mockResolvedValue({
      error: new Error("synthetic-send-failure"),
    });

    await expect(
      requestEmailOtp("person@example.test", context),
    ).rejects.toThrow("synthetic-send-failure");
    expect(localStorage).toHaveLength(0);
  });

  it("takes the same-tab story context once after authentication", () => {
    storeAuthReturnContext(context);

    expect(takeAuthReturnContext()).toEqual(context);
    expect(takeAuthReturnContext()).toBeNull();
    expect(localStorage).toHaveLength(0);
  });

  it("verifies the pasted email code and removes whitespace", async () => {
    await expect(
      verifyEmailOtp(" person@example.test ", " 123 456 "),
    ).resolves.toBeNull();

    expect(mocks.verifyOtp).toHaveBeenCalledWith({
      email: "person@example.test",
      token: "123456",
      type: "email",
    });
  });

  it("keeps the pending story context retryable after a failed code", async () => {
    storeAuthReturnContext(context);
    mocks.verifyOtp.mockResolvedValue({
      data: { session: null },
      error: new Error("synthetic-invalid-code"),
    });

    await expect(
      verifyEmailOtp("person@example.test", "000000"),
    ).rejects.toThrow("synthetic-invalid-code");
    expect(takeAuthReturnContext()).toEqual(context);
  });

  it("rejects expired story context without exposing it to the app", () => {
    storeAuthReturnContext(context);
    const key = storedKey();
    localStorage.setItem(
      key,
      JSON.stringify({ context, expiresAt: Date.now() - 1 }),
    );

    expect(takeAuthReturnContext()).toBeNull();
    expect(localStorage).toHaveLength(0);
  });
});
