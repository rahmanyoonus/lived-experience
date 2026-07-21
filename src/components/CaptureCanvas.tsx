import type {
  ChangeEvent,
  MouseEventHandler,
  SyntheticEvent,
} from "react";

import { DiscardDraftDialog } from "./DiscardDraftDialog";
import {
  EmailContinuationDialog,
  type MagicLinkRequestResult,
} from "./EmailContinuationDialog";
import {
  MicrophoneDialog,
  type MicrophoneDialogKind,
} from "./MicrophoneDialog";

export const EXAMPLE_STORY_TEXT = `One of my clearest childhood memories is helping my grandfather open his little bicycle repair shop before sunrise. I would line up the tools while he lifted the shutters, and the whole street smelled of rain and strong tea.

Years later, when I had to begin again in a new town, I remembered how patiently he worked. He never rushed a repair or made anyone feel foolish for asking for help. I think that is where I learnt to take my time, listen carefully and leave things a little better than I found them.`;

export type CapturePhase =
  | "empty"
  | "recording"
  | "processing"
  | "editing"
  | "error";

export type PersistenceState =
  | "idle"
  | "saving"
  | "saved-locally"
  | "securing"
  | "saved"
  | "not-yet-synced"
  | "sync-error";

export interface EditorSelection {
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
}

export interface CaptureReadinessNotice {
  readonly message: string;
  readonly tone: "blocking" | "warning";
}

export interface CaptureCanvasProps {
  content: string;
  phase: CapturePhase;
  persistenceState: PersistenceState;
  hasStarted: boolean;
  isAuthenticated: boolean;
  recordingDurationSeconds?: number;
  captureMessage?: string | null;
  readinessNotice?: CaptureReadinessNotice | null;
  captureDisabled?: boolean;
  microphoneDialog?: MicrophoneDialogKind | null;
  microphoneWarning?: string | null;
  discardDraftDialogOpen?: boolean;
  emailDialogOpen?: boolean;
  emailSignInAvailable?: boolean;
  hasOriginalAudio?: boolean;
  hasOriginalTranscript?: boolean;
  hasPendingRecording?: boolean;
  hasVersionHistory?: boolean;
  onContentChange: (content: string) => void;
  onEditorSelectionChange?: (selection: EditorSelection) => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onRetryCapture?: () => void;
  onKeepAudioAndContinue?: () => void;
  onDownloadRecordingBackup?: () => void;
  onReviewConflictVersions?: () => void;
  onDiscardRecoveredDraft?: () => void;
  onConfirmDiscardRecoveredDraft?: () => void;
  onDismissDiscardRecoveredDraft?: () => void;
  onStartNewStory?: () => void;
  startNewStoryDisabled?: boolean;
  onSyncNow?: () => void;
  onKeepStory?: () => void;
  onSendMagicLink?: (email: string) => Promise<MagicLinkRequestResult>;
  onDismissEmailDialog?: () => void;
  onConfirmMicrophone?: () => void;
  onDismissMicrophone?: () => void;
  onOpenStories?: () => void;
  onOpenOriginalAudio?: () => void;
  onOpenOriginalTranscript?: () => void;
  onOpenVersionHistory?: () => void;
  onGuideMe?: () => void;
  onGivePrompt?: () => void;
}

interface StatusPresentation {
  label: string;
  detail?: string;
  tone: "quiet" | "working" | "local" | "complete" | "attention";
}

const persistencePresentations: Record<PersistenceState, StatusPresentation> = {
  idle: {
    label: "Not yet saved",
    tone: "quiet",
  },
  saving: {
    label: "Saving…",
    tone: "working",
  },
  "saved-locally": {
    label: "Saved locally",
    detail: "Only on this device",
    tone: "local",
  },
  securing: {
    label: "Securing your story…",
    tone: "working",
  },
  saved: {
    label: "Saved",
    detail: "Private in your account",
    tone: "complete",
  },
  "not-yet-synced": {
    label: "Not yet synced",
    detail: "Your latest changes remain on this device",
    tone: "attention",
  },
  "sync-error": {
    label: "Not yet synced",
    detail: "Keep this page open; your latest changes may not be saved yet",
    tone: "attention",
  },
};

const phaseLabels: Record<CapturePhase, string> = {
  empty: "Ready when you are",
  recording: "Listening",
  processing: "Processing transcript",
  editing: "Ready to continue",
  error: "Recording needs attention",
};

function formatDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return [hours, minutes, seconds]
      .map((part) => part.toString().padStart(2, "0"))
      .join(":");
  }

  return [minutes, seconds]
    .map((part) => part.toString().padStart(2, "0"))
    .join(":");
}

function describeDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  }
  if (minutes > 0) {
    parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds} ${seconds === 1 ? "second" : "seconds"}`);
  }

  return parts.join(", ");
}

function RecordingActivityWave() {
  return (
    <span aria-hidden="true" className="recording-wave">
      <svg
        className="recording-wave__svg"
        focusable="false"
        viewBox="0 0 48 12"
      >
        <path
          className="recording-wave__line"
          d="M-24 6 C-20 1 -16 1 -12 6 S-4 11 0 6 S8 1 12 6 S20 11 24 6 S32 1 36 6 S44 11 48 6 S56 1 60 6 S68 11 72 6"
        />
      </svg>
    </span>
  );
}

function MicrophoneIcon() {
  return (
    <svg
      aria-hidden="true"
      className="button-icon"
      viewBox="0 0 24 24"
      width="24"
      height="24"
    >
      <path
        d="M12 15.25a4 4 0 0 0 4-4v-5a4 4 0 1 0-8 0v5a4 4 0 0 0 4 4Zm-6.5-4a6.5 6.5 0 0 0 13 0M12 17.75V22m-3 0h6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function PersistenceStatus({
  state,
  onSyncNow,
}: {
  state: PersistenceState;
  onSyncNow?: () => void;
}) {
  const presentation = persistencePresentations[state];

  if (state === "idle") {
    return null;
  }

  return (
    <div
      className="persistence-status"
      data-tone={presentation.tone}
    >
      <div
        aria-atomic="true"
        aria-live="polite"
        className="persistence-status__message"
        role="status"
      >
        <span aria-hidden="true" className="status-mark">
          {presentation.tone === "complete"
            ? "✓"
            : presentation.tone === "attention"
              ? "!"
              : "·"}
        </span>
        <span className="persistence-status__copy">
          <span className="persistence-status__label">{presentation.label}</span>
          {presentation.detail ? (
            <span className="persistence-status__detail">
              {presentation.detail}
            </span>
          ) : null}
        </span>
      </div>
      {state === "not-yet-synced" && onSyncNow ? (
        <button
          className="persistence-status__action"
          onClick={onSyncNow}
          type="button"
        >
          Sync now
        </button>
      ) : null}
    </div>
  );
}

interface CaptureModeControlsProps {
  onGuideMe?: () => void;
  onGivePrompt?: () => void;
}

function CaptureModeControls({
  onGuideMe,
  onGivePrompt,
}: CaptureModeControlsProps) {
  return (
    <div
      aria-label="Capture support"
      className="mode-controls"
      role="group"
    >
      <button
        aria-pressed="true"
        className="mode-control mode-control--selected"
        type="button"
      >
        <span>Just listen</span>
        <span className="mode-control__meta">On</span>
      </button>
      <button
        aria-describedby={!onGuideMe ? "guide-unavailable" : undefined}
        aria-pressed="false"
        className="mode-control"
        disabled={!onGuideMe}
        onClick={onGuideMe}
        type="button"
      >
        <span>Guide me</span>
        {!onGuideMe ? (
          <span className="mode-control__meta" id="guide-unavailable">
            Not yet available
          </span>
        ) : null}
      </button>
      <button
        aria-describedby={!onGivePrompt ? "prompt-unavailable" : undefined}
        className="mode-control"
        disabled={!onGivePrompt}
        onClick={onGivePrompt}
        type="button"
      >
        <span>Give me a prompt</span>
        {!onGivePrompt ? (
          <span className="mode-control__meta" id="prompt-unavailable">
            Not yet available
          </span>
        ) : null}
      </button>
    </div>
  );
}

interface OriginalsAndHistoryProps {
  hasOriginalAudio: boolean;
  hasOriginalTranscript: boolean;
  hasVersionHistory: boolean;
  onOpenOriginalAudio?: () => void;
  onOpenOriginalTranscript?: () => void;
  onOpenVersionHistory?: () => void;
}

function OriginalsAndHistory({
  hasOriginalAudio,
  hasOriginalTranscript,
  hasVersionHistory,
  onOpenOriginalAudio,
  onOpenOriginalTranscript,
  onOpenVersionHistory,
}: OriginalsAndHistoryProps) {
  const hasAnything =
    hasOriginalAudio || hasOriginalTranscript || hasVersionHistory;

  if (!hasAnything) {
    return null;
  }

  return (
    <details className="originals-panel">
      <summary>Originals &amp; history</summary>
      <p>
        Your original recording and first transcript stay separate from your
        edits.
      </p>
      <div className="originals-panel__actions">
        {hasOriginalAudio && onOpenOriginalAudio ? (
          <button
            className="text-action"
            onClick={onOpenOriginalAudio}
            type="button"
          >
            Listen to original audio
          </button>
        ) : null}
        {hasOriginalTranscript && onOpenOriginalTranscript ? (
          <button
            className="text-action"
            onClick={onOpenOriginalTranscript}
            type="button"
          >
            View original transcript
          </button>
        ) : null}
        {hasVersionHistory && onOpenVersionHistory ? (
          <button
            className="text-action"
            onClick={onOpenVersionHistory}
            type="button"
          >
            View version history
          </button>
        ) : null}
      </div>
    </details>
  );
}

export function CaptureCanvas({
  content,
  phase,
  persistenceState,
  hasStarted,
  isAuthenticated,
  recordingDurationSeconds = 0,
  captureMessage,
  readinessNotice = null,
  captureDisabled = false,
  microphoneDialog = null,
  microphoneWarning = null,
  discardDraftDialogOpen = false,
  emailDialogOpen = false,
  emailSignInAvailable = true,
  hasOriginalAudio = false,
  hasOriginalTranscript = false,
  hasPendingRecording = false,
  hasVersionHistory = false,
  onContentChange,
  onEditorSelectionChange,
  onStartRecording,
  onStopRecording,
  onRetryCapture,
  onKeepAudioAndContinue,
  onDownloadRecordingBackup,
  onReviewConflictVersions,
  onDiscardRecoveredDraft,
  onConfirmDiscardRecoveredDraft,
  onDismissDiscardRecoveredDraft,
  onStartNewStory,
  startNewStoryDisabled = false,
  onSyncNow,
  onKeepStory,
  onSendMagicLink,
  onDismissEmailDialog,
  onConfirmMicrophone,
  onDismissMicrophone,
  onOpenStories,
  onOpenOriginalAudio,
  onOpenOriginalTranscript,
  onOpenVersionHistory,
  onGuideMe,
  onGivePrompt,
}: CaptureCanvasProps) {
  const isRecording = phase === "recording";
  const isProcessing = phase === "processing";
  const canKeepStory = hasStarted && !isAuthenticated && Boolean(onKeepStory);
  const canUseExampleText =
    !captureDisabled &&
    !hasStarted &&
    content.length === 0 &&
    !isRecording &&
    !isProcessing;

  const handleContentChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onContentChange(event.currentTarget.value);
  };

  const handleEditorSelection = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    if (!onEditorSelectionChange) {
      return;
    }

    const editor = event.currentTarget;
    onEditorSelectionChange({
      start: editor.selectionStart,
      end: editor.selectionEnd,
      direction: editor.selectionDirection ?? "none",
    });
  };

  const recordingAction: MouseEventHandler<HTMLButtonElement> = isRecording
    ? onStopRecording
    : onStartRecording;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#story-editor">
        Skip to your story
      </a>

      <header className="site-header">
        <div className="site-header__inner">
          <div aria-label="Lived Experience" className="wordmark">
            Lived Experience
          </div>
          <nav aria-label="Main" className="site-navigation">
            {onStartNewStory ? (
              <button
                aria-current="page"
                className="navigation-tab navigation-tab--active"
                disabled={startNewStoryDisabled}
                onClick={onStartNewStory}
                type="button"
              >
                New story
              </button>
            ) : (
              <span
                aria-current="page"
                className="navigation-tab navigation-tab--active"
              >
                New story
              </span>
            )}
            {isAuthenticated ? (
              <button
                className="navigation-tab"
                disabled={!onOpenStories}
                onClick={onOpenStories}
                type="button"
              >
                Your stories
              </button>
            ) : null}
          </nav>
          <div className="site-header__status">
            <PersistenceStatus
              onSyncNow={onSyncNow}
              state={persistenceState}
            />
          </div>
        </div>
      </header>

      <main className="capture-layout">
        <section aria-labelledby="capture-heading" className="capture-canvas">
          {!hasStarted ? (
            <div className="capture-canvas__introduction">
              <h1 id="capture-heading">Start whenever you’re ready.</h1>
              <p className="capture-intro">
                Speak or write in your own words. Nothing needs to be finished
                today. Everything stays private, saved only on this device until
                you choose to keep it.
              </p>
              {canUseExampleText ? (
                <div className="example-starter">
                  <button
                    className="text-action"
                    onClick={() => onContentChange(EXAMPLE_STORY_TEXT)}
                    type="button"
                  >
                    Use example text
                  </button>
                  <span>
                    Adds a fictional sample you can edit or replace.
                  </span>
                </div>
              ) : null}
            </div>
          ) : (
            <h1 className="visually-hidden" id="capture-heading">
              Your story
            </h1>
          )}

          <div className="capture-workspace">

                <CaptureModeControls
                  onGivePrompt={onGivePrompt}
                  onGuideMe={onGuideMe}
                />

                <div className="editor-region">
                  {readinessNotice ? (
                    <div
                      className="readiness-alert"
                      data-tone={readinessNotice.tone}
                      id="capture-readiness"
                      role="alert"
                    >
                      {readinessNotice.message}
                    </div>
                  ) : null}
                  <label className="visually-hidden" htmlFor="story-editor">
                    Write or edit your story
                  </label>
                  <textarea
                    aria-describedby={
                      readinessNotice
                        ? "editor-help capture-readiness"
                        : "editor-help"
                    }
                    className="story-editor"
                    disabled={captureDisabled}
                    id="story-editor"
                    onChange={handleContentChange}
                    onSelect={handleEditorSelection}
                    placeholder="Start speaking or writing whenever you’re ready."
                    spellCheck="true"
                    value={content}
                  />
                  <p className="editor-help" id="editor-help">
                    Your words remain yours. Pause, change direction or return
                    whenever you want.
                  </p>
                </div>

                {isProcessing ? (
                  <p className="processing-note">
                    Preparing a faithful transcript. You can keep writing while
                    it is processed; another recording will be available when it
                    is ready.
                  </p>
                ) : null}

                {captureMessage ||
                onRetryCapture ||
                onKeepAudioAndContinue ||
                onDownloadRecordingBackup ||
                onReviewConflictVersions ? (
                  <div className="capture-alert" role="alert">
                    <p>
                      {captureMessage ??
                        "This recording needs your attention before you continue."}
                    </p>
                    {onRetryCapture ? (
                      <button
                        className="text-action"
                        onClick={onRetryCapture}
                        type="button"
                      >
                        Try again
                      </button>
                    ) : null}
                    {onKeepAudioAndContinue ? (
                      <button
                        className="text-action"
                        onClick={onKeepAudioAndContinue}
                        type="button"
                      >
                        Keep audio and continue
                      </button>
                    ) : null}
                    {onDownloadRecordingBackup ? (
                      <button
                        className="text-action"
                        onClick={onDownloadRecordingBackup}
                        type="button"
                      >
                        Download recording backup
                      </button>
                    ) : null}
                    {onReviewConflictVersions ? (
                      <button
                        className="text-action"
                        onClick={onReviewConflictVersions}
                        type="button"
                      >
                        Review versions
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {hasOriginalTranscript ? (
                  <p className="transcript-note">
                    Transcripts keep your words and add only punctuation,
                    capitalisation and paragraph breaks. You can edit this
                    version directly.
                  </p>
                ) : null}

                <OriginalsAndHistory
                  hasOriginalAudio={hasOriginalAudio}
                  hasOriginalTranscript={hasOriginalTranscript}
                  hasVersionHistory={hasVersionHistory}
                  onOpenOriginalAudio={onOpenOriginalAudio}
                  onOpenOriginalTranscript={onOpenOriginalTranscript}
                  onOpenVersionHistory={onOpenVersionHistory}
                />

                <div className="capture-actions">
                  <button
                    className="recording-button"
                    data-recording={isRecording ? "true" : "false"}
                    aria-describedby={
                      captureDisabled
                        ? "capture-readiness"
                        : isProcessing
                          ? "recording-processing-help"
                          : hasPendingRecording
                            ? "recording-pending-help"
                            : undefined
                    }
                    disabled={
                      captureDisabled || isProcessing || hasPendingRecording
                    }
                    onClick={recordingAction}
                    type="button"
                  >
                    {isRecording ? (
                      <span aria-hidden="true" className="stop-icon" />
                    ) : (
                      <MicrophoneIcon />
                    )}
                    <span>
                      {isRecording
                        ? "Stop recording"
                        : isProcessing
                          ? "Preparing transcript"
                          : hasPendingRecording
                            ? "Transcript needs attention"
                            : "Start recording"}
                    </span>
                  </button>
                  <div className="capture-state-row">
                    {isRecording ? <RecordingActivityWave /> : null}
                    <div
                      aria-atomic="true"
                      aria-live="polite"
                      className="capture-state"
                      role="status"
                    >
                      <span
                        aria-hidden="true"
                        className="capture-state__mark"
                        data-phase={phase}
                      />
                      <span>{phaseLabels[phase]}</span>
                    </div>
                    {isRecording ? (
                      <time
                        aria-label={`Recording duration ${describeDuration(recordingDurationSeconds)}`}
                        className="recording-duration"
                        dateTime={`PT${Math.max(0, Math.floor(recordingDurationSeconds))}S`}
                        role="timer"
                      >
                        {formatDuration(recordingDurationSeconds)}
                      </time>
                    ) : null}
                  </div>
                  {isProcessing ? (
                    <span
                      className="visually-hidden"
                      id="recording-processing-help"
                    >
                      Wait until the current transcript is ready before starting
                      another recording.
                    </span>
                  ) : null}
                  {hasPendingRecording && !isProcessing ? (
                    <span
                      className="visually-hidden"
                      id="recording-pending-help"
                    >
                      Retry the saved recording’s transcript before starting
                      another recording.
                    </span>
                  ) : null}

                  {canKeepStory ? (
                    <div className="keep-story">
                      <button
                        className="keep-story__button"
                        disabled={isRecording || isProcessing}
                        onClick={onKeepStory}
                        type="button"
                      >
                        Keep this story
                      </button>
                      <span className="keep-story__note">
                        {isRecording
                          ? "Available after you stop recording"
                          : isProcessing
                            ? "Available when the transcript is ready"
                            : emailSignInAvailable
                              ? "Sign in by email when you’re ready"
                              : "Email sign-in isn’t connected here yet"}
                      </span>
                    </div>
                  ) : null}
                </div>

                {!hasStarted ? (
                  <p className="capture-reassurance">
                    Nothing needs to be finished today.
                  </p>
                ) : null}

                {onDiscardRecoveredDraft || onStartNewStory ? (
                  <div className="draft-lifecycle-actions">
                    {onDiscardRecoveredDraft ? (
                      <button
                        className="text-action draft-lifecycle-actions__button"
                        disabled={isRecording || isProcessing}
                        onClick={onDiscardRecoveredDraft}
                        type="button"
                      >
                        Discard draft
                      </button>
                    ) : null}
                    {onStartNewStory ? (
                      <button
                        aria-describedby={
                          startNewStoryDisabled
                            ? "new-story-unavailable"
                            : undefined
                        }
                        className="text-action draft-lifecycle-actions__button"
                        disabled={startNewStoryDisabled}
                        onClick={onStartNewStory}
                        type="button"
                      >
                        Start a new story
                      </button>
                    ) : null}
                    {onStartNewStory && startNewStoryDisabled ? (
                      <span
                        className="visually-hidden"
                        id="new-story-unavailable"
                      >
                        Finish the current recording and wait until every change
                        is saved before starting a new story.
                      </span>
                    ) : null}
                  </div>
                ) : null}
          </div>
        </section>

        <aside aria-label="Privacy note" className="privacy-note">
          <p>
            <strong>Private by default.</strong>{" "}
            {isAuthenticated
              ? "Only you can open stories saved to your account."
              : "Until you sign in by email, this draft stays only in this browser on this device."}
          </p>
        </aside>
      </main>

      {microphoneDialog && onDismissMicrophone ? (
        <MicrophoneDialog
          kind={microphoneDialog}
          onConfirm={onConfirmMicrophone}
          onDismiss={onDismissMicrophone}
          warning={microphoneWarning}
        />
      ) : null}

      {emailDialogOpen &&
      onSendMagicLink &&
      onDismissEmailDialog ? (
        <EmailContinuationDialog
          available={emailSignInAvailable}
          onDismiss={onDismissEmailDialog}
          onSendLink={onSendMagicLink}
        />
      ) : null}

      {discardDraftDialogOpen &&
      onConfirmDiscardRecoveredDraft &&
      onDismissDiscardRecoveredDraft ? (
        <DiscardDraftDialog
          onConfirm={onConfirmDiscardRecoveredDraft}
          onDismiss={onDismissDiscardRecoveredDraft}
        />
      ) : null}
    </div>
  );
}

export default CaptureCanvas;
