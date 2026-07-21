import { useId } from "react";

import { ModalDialog } from "./ModalDialog";
import "./StoryLibraryDialog.css";

export interface StoryLibraryItem {
  id: string;
  title: string | null;
  capturedAt: string;
  updatedAt: string;
  excerpt: string;
  totalVoiceDurationMs: number | null;
}

export interface StoryLibraryDialogProps {
  items: readonly StoryLibraryItem[];
  loading: boolean;
  error: string | null;
  onOpen: (id: string) => void;
  onRetry: () => void;
  onDismiss: () => void;
}

const capturedDateFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
});

const shortDateFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
});

function formatDate(value: string, includeTime: boolean): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Date unavailable";
  }

  return includeTime
    ? capturedDateFormatter.format(date)
    : shortDateFormatter.format(date);
}

function shortenVerbatim(value: string, maximumCharacters = 64): string {
  const characters = Array.from(value.trim());
  if (characters.length <= maximumCharacters) {
    return characters.join("");
  }

  return `${characters.slice(0, maximumCharacters - 1).join("")}…`;
}

function getDisplayTitle(item: StoryLibraryItem): string {
  const suppliedTitle = item.title?.trim();
  if (suppliedTitle) {
    return suppliedTitle;
  }

  const date = formatDate(item.capturedAt, false);
  const excerpt = shortenVerbatim(item.excerpt);
  return excerpt ? `${date} — ${excerpt}` : date;
}

function formatVoiceDuration(durationMs: number | null): string {
  if (durationMs === null || durationMs <= 0) {
    return "No voice recording";
  }

  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds === 0) {
    return "Voice · Less than 1 sec";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
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

  return `Voice · ${parts.join(" ")}`;
}

export function StoryLibraryDialog({
  items,
  loading,
  error,
  onOpen,
  onRetry,
  onDismiss,
}: StoryLibraryDialogProps) {
  const id = useId();
  const titleId = `${id}-story-library-title`;
  const descriptionId = `${id}-story-library-description`;

  return (
    <ModalDialog
      describedBy={descriptionId}
      labelledBy={titleId}
      onDismiss={onDismiss}
    >
      <section className="story-library-dialog">
        <header className="story-library-dialog__header">
          <div>
            <h2 id={titleId}>Your stories</h2>
            <p id={descriptionId}>
              Open a private story to continue it in the capture canvas.
            </p>
          </div>
          <button
            aria-label="Close your stories"
            className="story-library-dialog__close"
            onClick={onDismiss}
            type="button"
          >
            Close
          </button>
        </header>

        {loading ? (
          <div
            aria-live="polite"
            className="story-library-dialog__state"
            role="status"
          >
            <p>Loading your stories…</p>
          </div>
        ) : null}

        {!loading && error ? (
          <div className="story-library-dialog__state" role="alert">
            <p>{error}</p>
            <button
              className="story-library-dialog__retry"
              onClick={onRetry}
              type="button"
            >
              Try again
            </button>
          </div>
        ) : null}

        {!loading && !error && items.length === 0 ? (
          <div className="story-library-dialog__state">
            <p className="story-library-dialog__state-title">
              No saved stories yet
            </p>
            <p>Stories you keep will appear here.</p>
          </div>
        ) : null}

        {!loading && !error && items.length > 0 ? (
          <ul
            aria-label="Your saved stories"
            className="story-library-dialog__list"
          >
            {items.map((item, index) => {
              const displayTitle = getDisplayTitle(item);
              const itemTitleId = `${id}-story-${index}-title`;
              const itemDetailsId = `${id}-story-${index}-details`;

              return (
                <li key={item.id}>
                  <article
                    aria-labelledby={itemTitleId}
                    className="story-library-card"
                  >
                    <div className="story-library-card__body">
                      <h3 id={itemTitleId}>{displayTitle}</h3>
                      <div
                        className="story-library-card__metadata"
                        id={itemDetailsId}
                      >
                        <time dateTime={item.capturedAt}>
                          {formatDate(item.capturedAt, true)}
                        </time>
                        <span aria-hidden="true">·</span>
                        <span>{formatVoiceDuration(item.totalVoiceDurationMs)}</span>
                      </div>
                      <p className="story-library-card__excerpt">
                        {item.excerpt || "No text excerpt yet."}
                      </p>
                    </div>
                    <button
                      aria-describedby={itemDetailsId}
                      aria-label={`Open ${displayTitle}`}
                      className="story-library-card__open"
                      onClick={() => onOpen(item.id)}
                      type="button"
                    >
                      Continue
                    </button>
                  </article>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
    </ModalDialog>
  );
}
