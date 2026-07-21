import { ModalDialog } from "./ModalDialog";

export interface DiscardDraftDialogProps {
  onConfirm: () => void;
  onDismiss: () => void;
}

export function DiscardDraftDialog({
  onConfirm,
  onDismiss,
}: DiscardDraftDialogProps) {
  return (
    <ModalDialog
      describedBy="discard-draft-description"
      labelledBy="discard-draft-title"
      onDismiss={onDismiss}
    >
      <h2 id="discard-draft-title">Discard this draft?</h2>
      <p id="discard-draft-description">
        This removes the draft, its recordings and its history from this
        browser. It has not been saved to your account and cannot be recovered
        after you discard it.
      </p>
      <div className="dialog-card__actions">
        <button className="primary-button" onClick={onDismiss} type="button">
          Keep draft
        </button>
        <button className="secondary-button" onClick={onConfirm} type="button">
          Discard draft
        </button>
      </div>
    </ModalDialog>
  );
}
