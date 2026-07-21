import { useState, type FormEvent } from "react";

import { ModalDialog } from "./ModalDialog";

export type MagicLinkRequestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export interface EmailContinuationDialogProps {
  available?: boolean;
  onDismiss: () => void;
  onSendLink: (email: string) => Promise<MagicLinkRequestResult>;
}

export function EmailContinuationDialog({
  available = true,
  onDismiss,
  onSendLink,
}: EmailContinuationDialogProps) {
  const [email, setEmail] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!available || sending) {
      return;
    }

    const normalisedEmail = email.trim();
    if (!normalisedEmail) {
      setFeedback("Enter the email address you want to use for this account.");
      return;
    }

    setSending(true);
    setFeedback(null);
    try {
      const result = await onSendLink(normalisedEmail);
      if (result.ok) {
        setSentTo(normalisedEmail);
      } else {
        setFeedback(result.message);
      }
    } catch {
      setFeedback(
        "We couldn’t send the sign-in link. Your story remains saved on this device.",
      );
    } finally {
      setSending(false);
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
        <>
          <p id="email-continuation-description">
            Check your email. We sent a secure sign-in link to {sentTo}. Open
            it in this browser to return to this story and save it privately to
            your account.
          </p>
          <p className="dialog-card__fine-print">
            Until you return, this draft remains saved only on this device.
          </p>
          <div className="dialog-card__actions">
            <button className="primary-button" onClick={onDismiss} type="button">
              Keep working on this device
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={(event) => void handleSubmit(event)}>
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
            We’ll email you a link. No password needed. The link can only be
            used once and expires shortly.
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
                  ? "Sending link…"
                  : "Email me a link"}
            </button>
          </div>
        </form>
      )}
    </ModalDialog>
  );
}
