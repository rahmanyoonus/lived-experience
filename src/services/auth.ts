import type { AuthChangeEvent, Session } from "@supabase/supabase-js";

import { requireSupabaseClient } from "../lib/supabase";

const AUTH_RETURN_CONTEXT_KEY_PREFIX =
  "lived-experience.auth-return-context.v2";
const AUTH_RETURN_PARAM = "auth_return";
const AUTH_RETURN_TTL_MS = 60 * 60 * 1_000;

export interface AuthReturnContext {
  clientStoryId: string;
  selectionEnd: number;
  selectionStart: number;
}

interface StoredAuthReturnContext {
  context: AuthReturnContext;
  expiresAt: number;
}

function authReturnKey(attemptId: string): string {
  return `${AUTH_RETURN_CONTEXT_KEY_PREFIX}.${attemptId}`;
}

export function storeAuthReturnContext(
  context: AuthReturnContext,
  attemptId = crypto.randomUUID(),
): string {
  const stored: StoredAuthReturnContext = {
    context,
    expiresAt: Date.now() + AUTH_RETURN_TTL_MS,
  };
  localStorage.setItem(authReturnKey(attemptId), JSON.stringify(stored));
  return attemptId;
}

export function takeAuthReturnContext(): AuthReturnContext | null {
  if (window.location.pathname !== "/auth/confirm") {
    return null;
  }
  const attemptId = new URL(window.location.href).searchParams.get(
    AUTH_RETURN_PARAM,
  );
  if (!attemptId || !/^[0-9a-f-]{36}$/i.test(attemptId)) {
    return null;
  }

  const key = authReturnKey(attemptId);
  const encoded = localStorage.getItem(key);
  localStorage.removeItem(key);
  if (!encoded) {
    return null;
  }

  try {
    const candidate: unknown = JSON.parse(encoded);
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "context" in candidate &&
      "expiresAt" in candidate &&
      typeof candidate.expiresAt === "number" &&
      candidate.expiresAt >= Date.now() &&
      typeof candidate.context === "object" &&
      candidate.context !== null &&
      "clientStoryId" in candidate.context &&
      "selectionStart" in candidate.context &&
      "selectionEnd" in candidate.context &&
      typeof candidate.context.clientStoryId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        candidate.context.clientStoryId,
      ) &&
      typeof candidate.context.selectionStart === "number" &&
      Number.isFinite(candidate.context.selectionStart) &&
      candidate.context.selectionStart >= 0 &&
      typeof candidate.context.selectionEnd === "number" &&
      Number.isFinite(candidate.context.selectionEnd) &&
      candidate.context.selectionEnd >= candidate.context.selectionStart
    ) {
      return {
        clientStoryId: candidate.context.clientStoryId,
        selectionStart: candidate.context.selectionStart,
        selectionEnd: candidate.context.selectionEnd,
      };
    }
  } catch {
    return null;
  }

  return null;
}

export async function continueWithEmailMagicLink(
  email: string,
  context: AuthReturnContext,
): Promise<void> {
  const attemptId = storeAuthReturnContext(context);
  const redirectUrl = new URL("/auth/confirm", window.location.origin);
  redirectUrl.searchParams.set(AUTH_RETURN_PARAM, attemptId);
  const supabase = requireSupabaseClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: {
      emailRedirectTo: redirectUrl.toString(),
      shouldCreateUser: true,
    },
  });

  if (error) {
    localStorage.removeItem(authReturnKey(attemptId));
    throw error;
  }
}

export async function completeEmailMagicLinkReturn(): Promise<void> {
  if (window.location.pathname !== "/auth/confirm") {
    return;
  }

  const url = new URL(window.location.href);
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  if (!tokenHash || type !== "email") {
    throw new Error("The email sign-in link is invalid or incomplete.");
  }

  const supabase = requireSupabaseClient();
  const { error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: "email",
  });
  if (error) {
    throw error;
  }

  url.searchParams.delete("token_hash");
  url.searchParams.delete("type");
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

export async function getCurrentSession(): Promise<Session | null> {
  const supabase = requireSupabaseClient();
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    throw error;
  }
  return data.session;
}

export function onAuthStateChange(
  listener: (event: AuthChangeEvent, session: Session | null) => void,
): () => void {
  const supabase = requireSupabaseClient();
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange(listener);

  return () => subscription.unsubscribe();
}
