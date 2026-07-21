import { useState, type FormEvent } from "react";

import { ModalDialog } from "./ModalDialog";

export type EmailOtpResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export interface EmailContinuationDialogProps {
  available?: boolean;
  onDismiss: () => void;
  onRequestCode: (email: string) => Promise<EmailOtpResult>;
  onVerifyCode: (email: string, code: string) => Promise<EmailOtpResult>;
}

export function EmailContinuationDialog({
  available = true,
  onDismiss,
  onRequestCode,
  onVerifyCode,
}: EmailContinuationDialogProps) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const requestCode = async (normalisedEmail: string) => {
    if (!available || sending) {
      return;
    }

    setSending(true);
    setFeedback(null);
    try {
      const result = await onRequestCode(normalisedEmail);
      if (result.ok) {
        setSentTo(normalisedEmail);
        setCode("");
      } else {
        setFeedback(result.message);
      }
    } catch {
      setFeedback(
        "We couldn’t send the verification code. Your story remains saved on this device.",
      );
    } finally {
      setSending(false);
    }
  };

  const handleEmailSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalisedEmail = email.trim();
    if (!normalisedEmail) {
      setFeedback("Enter the email address you want to use for this account.");
      return;
    }
    await requestCode(normalisedEmail);
  };

  const handleCodeSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sentTo || verifying) {
      return;
    }
    const normalisedCode = code.replace(/\s/g, "");
    if (!normalisedCode) {
      setFeedback("Enter the verification code from your email.");
      return;
    }

    setVerifying(true);
    setFeedback(null);
    try {
      const result = await onVerifyCode(sentTo, normalisedCode);
      if (result.ok) {
        onDismiss();
      } else {
        setFeedback(result.message);
      }
    } catch {
      setFeedback(
        "That code could not be verified. Check the code or request a new one.",
      );
    } finally {
      setVerifying(false);
    }
  };

  return (
    <ModalDialog
      describedBy="email-continuation-description"
      labelledBy="email-continuation-title"
      onDismiss={onDismiss}
    >
      <div aria-hidden="true" className="dialog-card__symbol">
        @
      </div>
      <h2 id="email-continuation-title">Keep this story</h2>
      {sentTo ? (
        <form onSubmit={(event) => void handleCodeSubmit(event)}>
          <p id="email-continuation-description">
            Check your email. Enter the verification code sent to {sentTo} in
            this tab to save this story privately to your account.
          </p>
          <label className="dialog-card__field">
            <span>Verification code</span>
            <input
              autoComplete="one-time-code"
              autoFocus
              disabled={verifying}
              inputMode="numeric"
              name="verification-code"
              onChange={(event) => setCode(event.target.value)}
              required
              type="text"
              value={code}
            />
          </label>
          <p className="dialog-card__fine-print">
            Keep this tab open while you copy the six-digit code. Until it is
            verified, this draft remains saved only on this device.
          </p>
          {feedback ? (
            <p aria-live="polite" className="dialog-card__feedback" role="status">
              {feedback}
            </p>
          ) : null}
          <div className="dialog-card__actions">
            <button
              className="secondary-button"
              disabled={sending || verifying}
              onClick={() => {
                setSentTo(null);
                setFeedback(null);
              }}
              type="button"
            >
              Change email
            </button>
            <button
              className="secondary-button"
              disabled={sending || verifying}
              onClick={() => void requestCode(sentTo)}
              type="button"
            >
              {sending ? "Sending new code…" : "Send a new code"}
            </button>
            <button
              className="primary-button"
              disabled={verifying || sending}
              type="submit"
            >
              {verifying ? "Verifying…" : "Verify code"}
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={(event) => void handleEmailSubmit(event)}>
          <p id="email-continuation-description">
            {available
              ? "This story is saved only in this browser on this device and is kept for up to 30 days. Save it to a private account so it is available when you return."
              : "This draft is saved only in this browser on this device and is kept for up to 30 days. Email sign-in isn’t connected in this environment yet, so keep working on this device for now."}
          </p>
          <label className="dialog-card__field">
            <span>Email address</span>
            <input
              autoComplete="email"
              disabled={!available || sending}
              inputMode="email"
              name="email"
              onChange={(event) => setEmail(event.target.value)}
              required
              type="email"
              value={email}
            />
          </label>
          <p className="dialog-card__fine-print">
            We’ll email you a six-digit code. Keep this tab open, then paste
            the code here. No password needed.
          </p>
          {feedback ? (
            <p aria-live="polite" className="dialog-card__feedback" role="status">
              {feedback}
            </p>
          ) : null}
          <div className="dialog-card__actions">
            <button
              className="secondary-button"
              onClick={onDismiss}
              type="button"
            >
              Not now
            </button>
            <button
              className="primary-button"
              disabled={!available || sending}
              type="submit"
            >
              {!available
                ? "Email sign-in unavailable"
                : sending
                  ? "Sending code…"
                  : "Email me a code"}
            </button>
          </div>
        </form>
      )}
    </ModalDialog>
  );
}
