import type { AuthChangeEvent, Session } from "@supabase/supabase-js";

import { requireSupabaseClient } from "../lib/supabase";

const EMAIL_OTP_CONTEXT_KEY = "lived-experience.email-otp-context.v3";
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

export function storeAuthReturnContext(
  context: AuthReturnContext,
): void {
  const stored: StoredAuthReturnContext = {
    context,
    expiresAt: Date.now() + AUTH_RETURN_TTL_MS,
  };
  localStorage.setItem(EMAIL_OTP_CONTEXT_KEY, JSON.stringify(stored));
}

export function takeAuthReturnContext(): AuthReturnContext | null {
  const encoded = localStorage.getItem(EMAIL_OTP_CONTEXT_KEY);
  localStorage.removeItem(EMAIL_OTP_CONTEXT_KEY);
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

export async function requestEmailOtp(
  email: string,
  context: AuthReturnContext,
): Promise<void> {
  storeAuthReturnContext(context);
  const supabase = requireSupabaseClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: {
      shouldCreateUser: true,
    },
  });

  if (error) {
    localStorage.removeItem(EMAIL_OTP_CONTEXT_KEY);
    throw error;
  }
}

export async function verifyEmailOtp(
  email: string,
  token: string,
): Promise<Session | null> {
  const supabase = requireSupabaseClient();
  const { data, error } = await supabase.auth.verifyOtp({
    email: email.trim(),
    token: token.replace(/\s/g, ""),
    type: "email",
  });
  if (error) {
    throw error;
  }
  return data.session;
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
