import { useEffect, useId, useRef, useState } from "react";

import { ModalDialog } from "./ModalDialog";
import "./StoryArtefactsDialog.css";

export type StoryArtefactsMode = "audio" | "transcript" | "versions";

export interface StoryAudioArtefact {
  readonly id: string;
  readonly recordedAt: string;
  readonly durationMs: number;
  /** Ordered internal containers for one explicit start-to-stop recording. */
  readonly parts: readonly StoryAudioPart[];
}

export interface StoryAudioPart {
  readonly src: string;
  readonly startOffsetMs: number;
  readonly durationMs: number;
}

export interface StoryTranscriptUncertainty {
  readonly start: number;
  readonly end: number;
  readonly audioStartMs: number;
  readonly audioEndMs: number;
  readonly confidence?: number;
}

export interface StoryTranscriptArtefact {
  readonly id: string;
  readonly createdAt: string;
  readonly text: string;
  readonly uncertainties: readonly StoryTranscriptUncertainty[];
  readonly audioId: string;
}

export interface StoryVersionArtefact {
  readonly id: string;
  readonly createdAt: string;
  readonly reason: string;
  readonly text: string;
  readonly conflictRole?: "device" | "account";
}

export interface StoryArtefactsDialogProps {
  readonly mode: StoryArtefactsMode;
  readonly audioItems: readonly StoryAudioArtefact[];
  readonly transcriptItems: readonly StoryTranscriptArtefact[];
  readonly versions: readonly StoryVersionArtefact[];
  readonly onPlayUncertainty: (
    audioId: string,
    audioStartMs: number,
  ) => void;
  readonly onRestoreVersion: (id: string) => void;
  readonly onDismiss: () => void;
}

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
});

const modeCopy: Record<
  StoryArtefactsMode,
  { title: string; description: string; empty: string }
> = {
  audio: {
    title: "Original audio",
    description:
      "Listen to the recordings that remain the source of truth for what was spoken.",
    empty: "No original recordings are available for this story.",
  },
  transcript: {
    title: "Original transcripts",
    description:
      "Review the first faithful transcript for each recording. Any uncertain wording links back to its complete stored audio part.",
    empty: "No original transcripts are available for this story.",
  },
  versions: {
    title: "Version history",
    description:
      "Earlier edits remain recoverable. Restoring one adds a new current version and does not erase later work.",
    empty: "No earlier versions are available for this story.",
  },
};

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : dateFormatter.format(date);
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "Duration unavailable";
  }

  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds === 0) {
    return "Less than 1 sec";
  }

  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours} hr`);
  }
  if (minutes > 0) {
    parts.push(`${minutes} min`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds} sec`);
  }

  return parts.join(" ");
}

function formatAudioOffset(offsetMs: number): string {
  if (!Number.isFinite(offsetMs) || offsetMs < 0) {
    return "time unavailable";
  }

  const totalTenths = Math.floor(offsetMs / 100);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${tenths}`;
}

function suppliedUncertainText(
  text: string,
  uncertainty: StoryTranscriptUncertainty,
): string | null {
  if (
    !Number.isInteger(uncertainty.start) ||
    !Number.isInteger(uncertainty.end) ||
    uncertainty.start < 0 ||
    uncertainty.end <= uncertainty.start ||
    uncertainty.end > text.length
  ) {
    return null;
  }

  return text.slice(uncertainty.start, uncertainty.end);
}

function formatConfidence(confidence: number | undefined): string | null {
  if (
    confidence === undefined ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return null;
  }

  return `${Math.round(confidence * 100)}% transcription confidence`;
}

function formatVersionReason(reason: string): string {
  const words = reason.trim().replaceAll("-", " ");
  if (!words) {
    return "Saved version";
  }
  return `${words.charAt(0).toLocaleUpperCase("en-GB")}${words.slice(1)}`;
}

interface AudioArtefactsProps {
  readonly id: string;
  readonly items: readonly StoryAudioArtefact[];
}

function AudioArtefacts({ id, items }: AudioArtefactsProps) {
  if (items.length === 0) {
    return <EmptyArtefacts message={modeCopy.audio.empty} />;
  }

  return (
    <ol aria-label="Original recordings" className="story-artefacts-list">
      {items.map((item, index) => {
        const titleId = `${id}-audio-${index}-title`;
        const detailId = `${id}-audio-${index}-details`;

        return (
          <li key={item.id}>
            <article
              aria-labelledby={titleId}
              className="story-artefact-card"
            >
              <div className="story-artefact-card__heading">
                <h3 id={titleId}>Recording {index + 1}</h3>
                <p id={detailId}>
                  <time dateTime={item.recordedAt}>
                    {formatDate(item.recordedAt)}
                  </time>
                  <span aria-hidden="true"> · </span>
                  <span>{formatDuration(item.durationMs)}</span>
                </p>
              </div>
              <SegmentAudioPlayer
                describedBy={detailId}
                label={`Play original recording ${index + 1}`}
                parts={item.parts}
              />
            </article>
          </li>
        );
      })}
    </ol>
  );
}

function SegmentAudioPlayer({
  describedBy,
  label,
  parts,
}: {
  readonly describedBy: string;
  readonly label: string;
  readonly parts: readonly StoryAudioPart[];
}) {
  const [partIndex, setPartIndex] = useState(0);
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const continuePlaybackRef = useRef(false);
  const source = parts[partIndex]?.src;

  useEffect(() => {
    if (!continuePlaybackRef.current) {
      return;
    }
    continuePlaybackRef.current = false;
    const player = playerRef.current;
    if (player) {
      player.load();
      void player.play().catch(() => undefined);
    }
  }, [partIndex]);

  if (!source) {
    return <p className="story-artefact-note">Audio is unavailable.</p>;
  }

  return (
    <audio
      aria-describedby={describedBy}
      aria-label={label}
      controls
      onEnded={() => {
        if (partIndex + 1 < parts.length) {
          continuePlaybackRef.current = true;
          setPartIndex(partIndex + 1);
        } else if (partIndex !== 0) {
          setPartIndex(0);
        }
      }}
      preload="metadata"
      ref={playerRef}
      src={source}
      tabIndex={0}
    >
      Your browser does not support audio playback.
    </audio>
  );
}

interface TranscriptArtefactsProps {
  readonly id: string;
  readonly items: readonly StoryTranscriptArtefact[];
  readonly onPlayUncertainty: (
    audioId: string,
    audioStartMs: number,
  ) => void;
}

function TranscriptArtefacts({
  id,
  items,
  onPlayUncertainty,
}: TranscriptArtefactsProps) {
  if (items.length === 0) {
    return <EmptyArtefacts message={modeCopy.transcript.empty} />;
  }

  return (
    <ol aria-label="Original transcripts" className="story-artefacts-list">
      {items.map((item, transcriptIndex) => {
        const titleId = `${id}-transcript-${transcriptIndex}-title`;
        const transcriptLabel = `Transcript ${transcriptIndex + 1}`;

        return (
          <li key={item.id}>
            <article
              aria-labelledby={titleId}
              className="story-artefact-card story-artefact-card--transcript"
            >
              <div className="story-artefact-card__heading">
                <h3 id={titleId}>{transcriptLabel}</h3>
                <p>
                  <time dateTime={item.createdAt}>
                    {formatDate(item.createdAt)}
                  </time>
                </p>
              </div>
              <div
                aria-label={`Verbatim text of ${transcriptLabel.toLocaleLowerCase("en-GB")}`}
                className="story-artefact-text"
              >
                {item.text}
              </div>

              {item.uncertainties.length > 0 ? (
                <section
                  aria-labelledby={`${titleId}-uncertainties`}
                  className="story-uncertainties"
                >
                  <h4 id={`${titleId}-uncertainties`}>
                    Parts to review
                  </h4>
                  <ol>
                    {item.uncertainties.map((uncertainty, uncertaintyIndex) => {
                      const uncertainText = suppliedUncertainText(
                        item.text,
                        uncertainty,
                      );
                      const confidence = formatConfidence(
                        uncertainty.confidence,
                      );
                      const passageNumber = uncertaintyIndex + 1;

                      return (
                        <li
                          className="story-uncertainty"
                          key={`${uncertainty.start}-${uncertainty.end}-${uncertainty.audioStartMs}-${uncertaintyIndex}`}
                        >
                          <div>
                            <p className="story-uncertainty__label">
                              Review this part
                            </p>
                            {uncertainText !== null ? (
                              <blockquote>{uncertainText}</blockquote>
                            ) : (
                              <p className="story-uncertainty__unavailable">
                                The supplied text range is unavailable. Replay
                                the linked audio to review it.
                              </p>
                            )}
                            <p className="story-uncertainty__metadata">
                              Audio {formatAudioOffset(uncertainty.audioStartMs)}
                              –{formatAudioOffset(uncertainty.audioEndMs)}
                              {confidence ? ` · ${confidence}` : ""}
                            </p>
                          </div>
                          <button
                            aria-label={`Play audio part ${passageNumber} to review from ${transcriptLabel.toLocaleLowerCase("en-GB")}`}
                            className="story-artefact-action"
                            onClick={() =>
                              onPlayUncertainty(
                                item.audioId,
                                uncertainty.audioStartMs,
                              )
                            }
                            type="button"
                          >
                            Play this part
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ) : (
                <p className="story-artefact-note">
                  No uncertain passages were supplied for this transcript.
                </p>
              )}
            </article>
          </li>
        );
      })}
    </ol>
  );
}

interface VersionArtefactsProps {
  readonly id: string;
  readonly items: readonly StoryVersionArtefact[];
  readonly onRestoreVersion: (id: string) => void;
}

function VersionArtefacts({
  id,
  items,
  onRestoreVersion,
}: VersionArtefactsProps) {
  if (items.length === 0) {
    return <EmptyArtefacts message={modeCopy.versions.empty} />;
  }

  return (
    <ol aria-label="Recoverable story versions" className="story-artefacts-list">
      {items.map((item, index) => {
        const titleId = `${id}-version-${index}-title`;
        const detailId = `${id}-version-${index}-details`;

        return (
          <li key={item.id}>
            <article
              aria-labelledby={titleId}
              className="story-artefact-card story-artefact-card--version"
            >
              <div className="story-artefact-card__heading">
                <h3 id={titleId}>Version {index + 1}</h3>
                <p id={detailId}>
                  <time dateTime={item.createdAt}>
                    {formatDate(item.createdAt)}
                  </time>
                  <span aria-hidden="true"> · </span>
                  <span>{formatVersionReason(item.reason)}</span>
                </p>
              </div>
              <div
                aria-label={`Text of version ${index + 1}`}
                className="story-artefact-text story-artefact-text--version"
              >
                {item.text}
              </div>
              {item.conflictRole ? (
                <p className="story-artefact-note">
                  {item.conflictRole === "device"
                    ? "This device’s version"
                    : "Account-saved version"}
                </p>
              ) : null}
              <button
                aria-describedby={detailId}
                aria-label={
                  item.conflictRole
                    ? `Use ${item.conflictRole === "device" ? "this device’s" : "account-saved"} version ${index + 1}`
                    : `Restore version ${index + 1}`
                }
                className="story-artefact-action"
                onClick={() => onRestoreVersion(item.id)}
                type="button"
              >
                {item.conflictRole ? "Use this version" : "Restore this version"}
              </button>
            </article>
          </li>
        );
      })}
    </ol>
  );
}

function EmptyArtefacts({ message }: { readonly message: string }) {
  return (
    <div className="story-artefacts-empty">
      <p>{message}</p>
    </div>
  );
}

export function StoryArtefactsDialog({
  mode,
  audioItems,
  transcriptItems,
  versions,
  onPlayUncertainty,
  onRestoreVersion,
  onDismiss,
}: StoryArtefactsDialogProps) {
  const id = useId();
  const titleId = `${id}-story-artefacts-title`;
  const descriptionId = `${id}-story-artefacts-description`;
  const copy = modeCopy[mode];

  return (
    <ModalDialog
      describedBy={descriptionId}
      labelledBy={titleId}
      onDismiss={onDismiss}
    >
      <section className="story-artefacts-dialog">
        <header className="story-artefacts-dialog__header">
          <div>
            <p className="story-artefacts-dialog__eyebrow">
              Originals &amp; history
            </p>
            <h2 id={titleId}>{copy.title}</h2>
            <p id={descriptionId}>{copy.description}</p>
          </div>
          <button
            aria-label="Close originals and history"
            className="story-artefacts-dialog__close"
            onClick={onDismiss}
            type="button"
          >
            Close
          </button>
        </header>

        {mode === "audio" ? (
          <AudioArtefacts id={id} items={audioItems} />
        ) : null}
        {mode === "transcript" ? (
          <TranscriptArtefacts
            id={id}
            items={transcriptItems}
            onPlayUncertainty={onPlayUncertainty}
          />
        ) : null}
        {mode === "versions" ? (
          <VersionArtefacts
            id={id}
            items={versions}
            onRestoreVersion={onRestoreVersion}
          />
        ) : null}
      </section>
    </ModalDialog>
  );
}
