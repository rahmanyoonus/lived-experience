import type {
  ChangeEvent,
  MouseEventHandler,
  SyntheticEvent,
} from "react";
import { useEffect, useRef, useState } from "react";

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

export type GuidancePromptState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly prompt: string }
  | { readonly status: "error"; readonly message: string };

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
  guidancePromptState?: GuidancePromptState;
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
  onOpenStoryVisualisation?: () => void;
  onOpenOriginalAudio?: () => void;
  onOpenOriginalTranscript?: () => void;
  onOpenVersionHistory?: () => void;
  onInterviewMe?: () => void;
  onRequestPrompt?: () => void;
  onDismissPrompt?: () => void;
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

const phaseLabels: Record<
  Exclude<CapturePhase, "editing" | "empty">,
  string
> = {
  recording: "Listening",
  processing: "Processing transcript",
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

const editorHelpText = {
  prompt: "Click here for story ideas and prompts to get you going.",
  editor: "Type here. Dont worry about spelling and punctuations.",
  recording:
    "Click here to speak and record your memories. Transcripts are automatically generated for your review.",
  flowMode: "Click here to hide all distractions.",
} as const;

function joinDescriptionIds(
  ...ids: Array<string | false | null | undefined>
): string | undefined {
  const description = ids.filter(Boolean).join(" ");
  return description || undefined;
}

function HelpCue({
  id,
  side,
  text,
}: {
  id: string;
  side: "left" | "right";
  text: string;
}) {
  return (
    <aside className="help-cue" data-side={side} id={id}>
      {side === "right" ? (
        <span aria-hidden="true" className="help-cue__arrow" />
      ) : null}
      <p className="help-cue__bubble">{text}</p>
      {side === "left" ? (
        <span aria-hidden="true" className="help-cue__arrow" />
      ) : null}
    </aside>
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
  onInterviewMe?: () => void;
  onRequestPrompt?: () => void;
  promptBusy: boolean;
  promptDisabled: boolean;
  showHelp: boolean;
}

function CaptureModeControls({
  onInterviewMe,
  onRequestPrompt,
  promptBusy,
  promptDisabled,
  showHelp,
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
        aria-describedby={!onInterviewMe ? "interview-unavailable" : undefined}
        aria-pressed="false"
        className="mode-control"
        disabled={!onInterviewMe}
        onClick={onInterviewMe}
        type="button"
      >
        <span>Interview me</span>
        {!onInterviewMe ? (
          <span className="mode-control__meta" id="interview-unavailable">
            Not yet available
          </span>
        ) : null}
      </button>
      <div className="help-anchor help-anchor--prompt help-anchor--right">
        <button
          aria-busy={promptBusy}
          aria-describedby={joinDescriptionIds(
            !onRequestPrompt && "prompt-unavailable",
            showHelp && "prompt-onboarding-help",
          )}
          className="mode-control"
          disabled={!onRequestPrompt || promptBusy || promptDisabled}
          onClick={onRequestPrompt}
          type="button"
        >
          <span>
            {promptBusy ? "Finding a prompt…" : "Guide me with a prompt"}
          </span>
          {!onRequestPrompt ? (
            <span className="mode-control__meta" id="prompt-unavailable">
              Not yet available
            </span>
          ) : null}
        </button>
        {showHelp ? (
          <HelpCue
            id="prompt-onboarding-help"
            side="right"
            text={editorHelpText.prompt}
          />
        ) : null}
      </div>
    </div>
  );
}

function GuidancePromptPanel({
  state,
  onRequestPrompt,
  onDismissPrompt,
  requestDisabled,
}: {
  state: GuidancePromptState;
  onRequestPrompt?: () => void;
  onDismissPrompt?: () => void;
  requestDisabled: boolean;
}) {
  if (state.status === "idle") {
    return null;
  }
  if (state.status === "loading") {
    return (
      <div
        aria-atomic="true"
        aria-label="Prompt guidance"
        aria-live="polite"
        className="guidance-prompt guidance-prompt--loading"
        role="status"
      >
        <span aria-hidden="true" className="guidance-prompt__mark">·</span>
        <span>Finding a prompt…</span>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="guidance-prompt guidance-prompt--error" role="alert">
        <p>{state.message}</p>
        <div className="guidance-prompt__actions">
          {onRequestPrompt ? (
            <button
              className="text-action"
              disabled={requestDisabled}
              onClick={onRequestPrompt}
              type="button"
            >
              Try again
            </button>
          ) : null}
          {onDismissPrompt ? (
            <button
              className="text-action"
              onClick={onDismissPrompt}
              type="button"
            >
              Dismiss
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <aside
      aria-atomic="true"
      aria-label="Prompt guidance"
      aria-live="polite"
      className="guidance-prompt"
      role="status"
    >
      <p className="guidance-prompt__eyebrow">A prompt for you</p>
      <p className="guidance-prompt__question">{state.prompt}</p>
      <p className="guidance-prompt__note">
        Use it if it helps, or carry on in your own direction.
      </p>
      <div className="guidance-prompt__actions">
        {onRequestPrompt ? (
          <button
            className="text-action"
            disabled={requestDisabled}
            onClick={onRequestPrompt}
            type="button"
          >
            Another prompt
          </button>
        ) : null}
        {onDismissPrompt ? (
          <button
            className="text-action"
            onClick={onDismissPrompt}
            type="button"
          >
            Dismiss
          </button>
        ) : null}
      </div>
    </aside>
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
  guidancePromptState = { status: "idle" },
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
  onOpenStoryVisualisation,
  onOpenOriginalAudio,
  onOpenOriginalTranscript,
  onOpenVersionHistory,
  onInterviewMe,
  onRequestPrompt,
  onDismissPrompt,
}: CaptureCanvasProps) {
  const [isFlowMode, setIsFlowMode] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const flowModeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFlowModeButtonFocusRef = useRef(false);
  const isRecording = phase === "recording";
  const isProcessing = phase === "processing";
  const canKeepStory = hasStarted && !isAuthenticated && Boolean(onKeepStory);
  const canUseExampleText =
    !captureDisabled &&
    !hasStarted &&
    content.length === 0 &&
    !isRecording &&
    !isProcessing;
  const promptRequestDisabled = captureDisabled || isRecording || isProcessing;
  const flowModeDisabled = captureDisabled || isRecording || isProcessing;

  useEffect(() => {
    if (isFlowMode) {
      editorRef.current?.focus();
      return;
    }

    if (restoreFlowModeButtonFocusRef.current) {
      restoreFlowModeButtonFocusRef.current = false;
      flowModeButtonRef.current?.focus();
    }
  }, [isFlowMode]);

  const exitFlowMode = () => {
    restoreFlowModeButtonFocusRef.current = true;
    setIsFlowMode(false);
  };

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
  const recordingButton = (
    <button
      className="recording-button"
      data-recording={isRecording ? "true" : "false"}
      aria-describedby={joinDescriptionIds(
        captureDisabled && "capture-readiness",
        !captureDisabled && isProcessing && "recording-processing-help",
        !captureDisabled &&
          !isProcessing &&
          hasPendingRecording &&
          "recording-pending-help",
        showHelp && "recording-onboarding-help",
      )}
      disabled={captureDisabled || isProcessing || hasPendingRecording}
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
  );

  return (
    <div
      className={isFlowMode ? "app-shell app-shell--flow-mode" : "app-shell"}
      onKeyDown={(event) => {
        if (isFlowMode && event.key === "Escape") {
          event.preventDefault();
          exitFlowMode();
        }
      }}
    >
      {!isFlowMode ? (
        <a className="skip-link" href="#story-editor">
          Skip to your story
        </a>
      ) : null}

      {!isFlowMode ? <header className="site-header">
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
                New Story
              </button>
            ) : (
              <span
                aria-current="page"
                className="navigation-tab navigation-tab--active"
              >
                New Story
              </span>
            )}
            {isAuthenticated ? (
              <>
                <button
                  className="navigation-tab"
                  disabled={!onOpenStories}
                  onClick={onOpenStories}
                  type="button"
                >
                  Your Stories
                </button>
                <button
                  className="navigation-tab"
                  data-visualise-stories-trigger
                  disabled={!onOpenStoryVisualisation}
                  onClick={onOpenStoryVisualisation}
                  type="button"
                >
                  Visualise My Stories
                </button>
              </>
            ) : null}
            <button
              aria-controls="capture-help-cues"
              aria-expanded={showHelp}
              aria-pressed={showHelp}
              className="help-toggle"
              onClick={() => setShowHelp((isVisible) => !isVisible)}
              type="button"
            >
              <span aria-hidden="true" className="help-toggle__mark">?</span>
              <span>Help Me</span>
            </button>
          </nav>
          <div className="site-header__status">
            <PersistenceStatus
              onSyncNow={onSyncNow}
              state={persistenceState}
            />
          </div>
        </div>
      </header> : null}

      <main
        className={
          isFlowMode
            ? "capture-layout capture-layout--flow-mode"
            : showHelp
              ? "capture-layout capture-layout--help"
              : "capture-layout"
        }
      >
        <section
          aria-labelledby="capture-heading"
          className={
            isFlowMode
              ? "capture-canvas capture-canvas--flow-mode"
              : "capture-canvas"
          }
        >
          {!isFlowMode && !hasStarted ? (
            <div className="capture-canvas__introduction">
              <h1 className="capture-heading" id="capture-heading">
                Welcome, Please start whenever you’re ready.
              </h1>
              <p className="capture-intro">
                Speak or write in your own words. Everything stays private.
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
                </div>
              ) : null}
            </div>
          ) : (
            <h1 className="visually-hidden" id="capture-heading">
              {isFlowMode ? "Your story in Flow Mode" : "Your story"}
            </h1>
          )}

          <div
            id="capture-help-cues"
            className={
              isFlowMode
                ? "capture-workspace capture-workspace--flow-mode"
                : "capture-workspace"
            }
          >

                {!isFlowMode ? <CaptureModeControls
                  onInterviewMe={onInterviewMe}
                  onRequestPrompt={onRequestPrompt}
                  promptBusy={guidancePromptState.status === "loading"}
                  promptDisabled={promptRequestDisabled}
                  showHelp={showHelp}
                /> : null}
                {!isFlowMode ? <GuidancePromptPanel
                  onDismissPrompt={onDismissPrompt}
                  onRequestPrompt={onRequestPrompt}
                  requestDisabled={promptRequestDisabled}
                  state={guidancePromptState}
                /> : null}

                <div
                  className={
                    isFlowMode
                      ? "editor-region editor-region--flow-mode"
                      : showHelp
                        ? "editor-region help-anchor help-anchor--editor help-anchor--left"
                        : "editor-region"
                  }
                >
                  {!isFlowMode && showHelp ? (
                    <HelpCue
                      id="editor-onboarding-help"
                      side="left"
                      text={editorHelpText.editor}
                    />
                  ) : null}
                  {!isFlowMode && readinessNotice ? (
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
                    aria-describedby={joinDescriptionIds(
                      !isFlowMode && "editor-help",
                      !isFlowMode && readinessNotice && "capture-readiness",
                      !isFlowMode && showHelp && "editor-onboarding-help",
                    )}
                    className={
                      isFlowMode
                        ? "story-editor story-editor--flow-mode"
                        : "story-editor"
                    }
                    disabled={captureDisabled}
                    id="story-editor"
                    onChange={handleContentChange}
                    onSelect={handleEditorSelection}
                    placeholder="Start speaking or writing whenever you’re ready."
                    ref={editorRef}
                    spellCheck="true"
                    value={content}
                  />
                  {!isFlowMode ? <p className="editor-help" id="editor-help">
                    Your words remain yours. Pause, change direction or return
                    whenever you want.
                  </p> : null}
                </div>

                {isFlowMode ? (
                  <div className="flow-mode-controls">
                    <button
                      className="flow-mode-exit"
                      onClick={exitFlowMode}
                      type="button"
                    >
                      Exit Flow Mode
                    </button>
                    <button
                      aria-describedby={
                        captureDisabled
                          ? "flow-recording-readiness-help"
                          : isProcessing
                            ? "flow-recording-processing-help"
                            : hasPendingRecording
                              ? "flow-recording-pending-help"
                              : undefined
                      }
                      aria-pressed={isRecording}
                      className="flow-mode-voice"
                      data-recording={isRecording ? "true" : "false"}
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
                              : "Voice Mode"}
                      </span>
                    </button>
                    {isRecording ? (
                      <div className="flow-mode-voice__activity">
                        <span
                          aria-live="polite"
                          className="visually-hidden"
                          role="status"
                        >
                          Voice recording active
                        </span>
                        <RecordingActivityWave />
                        <time
                          aria-label={`Recording duration ${describeDuration(recordingDurationSeconds)}`}
                          className="recording-duration flow-mode-voice__duration"
                          dateTime={`PT${Math.max(0, Math.floor(recordingDurationSeconds))}S`}
                          role="timer"
                        >
                          {formatDuration(recordingDurationSeconds)}
                        </time>
                      </div>
                    ) : null}
                    {captureDisabled ? (
                      <span
                        className="visually-hidden"
                        id="flow-recording-readiness-help"
                      >
                        {readinessNotice?.message ??
                          "Voice Mode is unavailable until capture is ready."}
                      </span>
                    ) : null}
                    {isProcessing ? (
                      <span
                        className="visually-hidden"
                        id="flow-recording-processing-help"
                      >
                        Wait until the current transcript is ready before starting
                        another recording.
                      </span>
                    ) : null}
                    {hasPendingRecording && !isProcessing ? (
                      <span
                        className="visually-hidden"
                        id="flow-recording-pending-help"
                      >
                        Retry the saved recording’s transcript before starting
                        another recording.
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <div className="flow-mode-entry">
                    <div className="help-anchor help-anchor--flow help-anchor--right">
                      <button
                        aria-describedby={joinDescriptionIds(
                          flowModeDisabled && "flow-mode-unavailable",
                          showHelp && "flow-mode-onboarding-help",
                        )}
                        className="flow-mode-entry__button"
                        disabled={flowModeDisabled}
                        onClick={() => setIsFlowMode(true)}
                        ref={flowModeButtonRef}
                        type="button"
                      >
                        Flow Mode
                      </button>
                      {showHelp ? (
                        <HelpCue
                          id="flow-mode-onboarding-help"
                          side="right"
                          text={editorHelpText.flowMode}
                        />
                      ) : null}
                    </div>
                    {flowModeDisabled ? (
                      <span className="visually-hidden" id="flow-mode-unavailable">
                        Flow Mode is available while you are writing.
                      </span>
                    ) : null}
                  </div>
                )}

                {!isFlowMode && isProcessing ? (
                  <p className="processing-note">
                    Preparing a faithful transcript. You can keep writing while
                    it is processed; another recording will be available when it
                    is ready.
                  </p>
                ) : null}

                {!isFlowMode && (captureMessage ||
                onRetryCapture ||
                onKeepAudioAndContinue ||
                onDownloadRecordingBackup ||
                onReviewConflictVersions) ? (
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

                {!isFlowMode && hasOriginalTranscript ? (
                  <p className="transcript-note">
                    Transcripts keep your words and add only punctuation,
                    capitalisation and paragraph breaks. You can edit this
                    version directly.
                  </p>
                ) : null}

                {!isFlowMode ? <OriginalsAndHistory
                  hasOriginalAudio={hasOriginalAudio}
                  hasOriginalTranscript={hasOriginalTranscript}
                  hasVersionHistory={hasVersionHistory}
                  onOpenOriginalAudio={onOpenOriginalAudio}
                  onOpenOriginalTranscript={onOpenOriginalTranscript}
                  onOpenVersionHistory={onOpenVersionHistory}
                /> : null}

                {!isFlowMode ? <div className="capture-actions">
                  {showHelp ? (
                    <div className="help-anchor help-anchor--recording help-anchor--left">
                      <HelpCue
                        id="recording-onboarding-help"
                        side="left"
                        text={editorHelpText.recording}
                      />
                      {recordingButton}
                    </div>
                  ) : recordingButton}
                  {onStartNewStory ? (
                    <button
                      aria-describedby={
                        startNewStoryDisabled
                          ? "new-story-unavailable"
                          : undefined
                      }
                      className="new-story-button"
                      disabled={startNewStoryDisabled}
                      onClick={onStartNewStory}
                      type="button"
                    >
                      New Story
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
                  {phase !== "editing" && phase !== "empty" ? (
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
                  ) : null}
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
                </div> : null}

                {!isFlowMode && onDiscardRecoveredDraft ? (
                  <div className="draft-lifecycle-actions">
                    <button
                      className="text-action draft-lifecycle-actions__button"
                      disabled={isRecording || isProcessing}
                      onClick={onDiscardRecoveredDraft}
                      type="button"
                    >
                      Discard draft
                    </button>
                  </div>
                ) : null}
          </div>
        </section>

        {!isFlowMode ? <aside aria-label="Privacy note" className="privacy-note">
          <p>
            <strong>Private by default.</strong>{" "}
            {isAuthenticated
              ? "Only you can open stories saved to your account."
              : "Until you sign in by email, this draft stays only in this browser on this device."}
          </p>
        </aside> : null}
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
