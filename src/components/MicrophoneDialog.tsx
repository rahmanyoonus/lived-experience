import { ModalDialog } from "./ModalDialog";

export type MicrophoneDialogKind =
  | "explanation"
  | "denied"
  | "unavailable"
  | "error";

export interface MicrophoneDialogProps {
  kind: MicrophoneDialogKind;
  warning?: string | null;
  onConfirm?: () => void;
  onDismiss: () => void;
}

const microphoneCopy: Record<
  MicrophoneDialogKind,
  {
    title: string;
    body: string;
    confirmLabel?: string;
    dismissLabel: string;
  }
> = {
  explanation: {
    title: "Use your microphone?",
    body: "Recording starts only after you allow microphone access, and stops only when you choose Stop recording. Silence won’t stop it. You’ll see your transcript after you stop and it is ready. If a transcript can’t be prepared, your recording stays saved so you can try again.",
    confirmLabel: "Allow and start",
    dismissLabel: "Not now",
  },
  denied: {
    title: "Microphone access is blocked",
    body: "Your browser didn’t allow microphone access. You can enable it in this site’s browser settings, then try again. Nothing was recorded, and you can keep writing meanwhile.",
    confirmLabel: "Try again",
    dismissLabel: "Keep writing",
  },
  unavailable: {
    title: "A microphone isn’t available",
    body: "This browser or device isn’t providing a microphone here. You can continue by writing your story.",
    dismissLabel: "Continue writing",
  },
  error: {
    title: "Recording couldn’t start",
    body: "Nothing new was captured. You can try again or continue writing while we leave your existing story unchanged.",
    confirmLabel: "Try again",
    dismissLabel: "Keep writing",
  },
};

export function MicrophoneDialog({
  kind,
  warning = null,
  onConfirm,
  onDismiss,
}: MicrophoneDialogProps) {
  const copy = microphoneCopy[kind];
  const titleId = `microphone-${kind}-title`;
  const descriptionId = `microphone-${kind}-description`;

  return (
    <ModalDialog
      describedBy={descriptionId}
      labelledBy={titleId}
      onDismiss={onDismiss}
    >
      <div aria-hidden="true" className="dialog-card__symbol">
        {kind === "explanation" ? "Mic" : "!"}
      </div>
      <h2 id={titleId}>{copy.title}</h2>
      <p id={descriptionId}>{copy.body}</p>
      {warning ? (
        <p className="dialog-card__warning" role="alert">
          {warning}
        </p>
      ) : null}
      <div className="dialog-card__actions">
        <button
          className="secondary-button"
          onClick={onDismiss}
          type="button"
        >
          {copy.dismissLabel}
        </button>
        {copy.confirmLabel && onConfirm ? (
          <button
            className="primary-button"
            onClick={onConfirm}
            type="button"
          >
            {copy.confirmLabel}
          </button>
        ) : null}
      </div>
    </ModalDialog>
  );
}
