import { useEffect, useId, useMemo, useRef, useState } from "react";

import { ModalDialog } from "./ModalDialog";
import type { StoryLibraryItem } from "./StoryLibraryDialog";
import "./StoryVisualisation.css";

export interface StoryVisualisationProps {
  items: readonly StoryLibraryItem[];
  loading: boolean;
  error: string | null;
  onOpen: (id: string) => void;
  onRetry: () => void;
  onDismiss: () => void;
}

const storyDateFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
});

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : storyDateFormatter.format(date);
}

function shortenVerbatim(value: string, maximumCharacters = 148): string {
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

  const excerpt = shortenVerbatim(item.excerpt, 56);
  return excerpt ? `${formatDate(item.capturedAt)} — ${excerpt}` : formatDate(item.capturedAt);
}

function formatVoiceDuration(durationMs: number | null): string | null {
  if (durationMs === null || durationMs <= 0) {
    return null;
  }

  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));
  return `Voice · ${totalMinutes} min`;
}

function createSeed(): number {
  const values = new Uint32Array(1);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(values);
    return values[0] ?? Date.now();
  }
  return Date.now();
}

function shuffledStories(
  items: readonly StoryLibraryItem[],
  seed: number,
): readonly StoryLibraryItem[] {
  const shuffled = [...items];
  let state = seed || 1;

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    const currentItem = shuffled[index];
    const targetItem = shuffled[target];
    if (currentItem && targetItem) {
      shuffled[index] = targetItem;
      shuffled[target] = currentItem;
    }
  }

  return shuffled;
}

function StoryFragment({
  item,
  interactive,
  onSelect,
}: {
  item: StoryLibraryItem;
  interactive: boolean;
  onSelect?: (id: string) => void;
}) {
  const title = getDisplayTitle(item);
  const excerpt = shortenVerbatim(item.excerpt) || "A story kept without a text excerpt.";
  const content = (
    <>
      <span className="story-fragment__date">{formatDate(item.capturedAt)}</span>
      <span className="story-fragment__title">{title}</span>
      <span className="story-fragment__excerpt">“{excerpt}”</span>
      {interactive ? (
        <span aria-hidden="true" className="story-fragment__prompt">
          Explore
          <span className="story-fragment__prompt-mark">↗</span>
        </span>
      ) : null}
    </>
  );

  return interactive ? (
    <button
      aria-label={`Explore ${title}`}
      className="story-fragment"
      onClick={() => onSelect?.(item.id)}
      type="button"
    >
      {content}
    </button>
  ) : (
    <article className="story-fragment story-fragment--echo">{content}</article>
  );
}

export function StoryVisualisation({
  items,
  loading,
  error,
  onOpen,
  onRetry,
  onDismiss,
}: StoryVisualisationProps) {
  const id = useId();
  const [seed, setSeed] = useState(createSeed);
  const [motionPaused, setMotionPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [pageHidden, setPageHidden] = useState(false);
  const [shuffleAnnouncement, setShuffleAnnouncement] = useState("");
  const [selectedStoryId, setSelectedStoryId] = useState<string | null>(null);
  const returnButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    returnButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return undefined;
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReducedMotion(query.matches);
    updatePreference();
    query.addEventListener?.("change", updatePreference);
    return () => query.removeEventListener?.("change", updatePreference);
  }, []);

  useEffect(() => {
    const updateVisibility = () => setPageHidden(document.hidden);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  const orderedItems = useMemo(() => shuffledStories(items, seed), [items, seed]);
  const lanes = useMemo(
    () =>
      [0, 1, 2]
        .map((laneIndex) =>
          orderedItems.filter((_, itemIndex) => itemIndex % 3 === laneIndex),
        )
        .filter((lane) => lane.length > 0),
    [orderedItems],
  );
  const selectedStory = items.find((item) => item.id === selectedStoryId) ?? null;
  const isPaused = motionPaused || reducedMotion || pageHidden || selectedStory !== null;

  const shuffle = () => {
    setSelectedStoryId(null);
    setSeed((current) => (current + 2_654_435_761) >>> 0);
    setShuffleAnnouncement("Stories rearranged.");
  };

  return (
    <div className="story-visualisation" data-paused={isPaused ? "true" : "false"}>
      <a className="skip-link" href="#story-visualisation-content">
        Skip to visualised stories
      </a>

      <header className="story-visualisation__header">
        <div aria-label="Lived Experience" className="wordmark">
          Lived Experience
        </div>
        <button
          className="story-visualisation__return"
          onClick={onDismiss}
          ref={returnButtonRef}
          type="button"
        >
          Back to your story
        </button>
      </header>

      <main className="story-visualisation__main" id="story-visualisation-content">
        <section aria-labelledby={`${id}-title`} className="story-visualisation__introduction">
          <div>
            <p className="story-visualisation__eyebrow">Private to you</p>
            <h1 id={`${id}-title`}>Visualise my stories</h1>
            <p className="story-visualisation__lede">
              A changing view of the stories you’ve kept, moving without chronology or a prescribed path.
            </p>
          </div>
          <div aria-label="Visualisation controls" className="story-visualisation__controls" role="group">
            <button
              aria-pressed={motionPaused || reducedMotion}
              className="story-visualisation__control"
              disabled={reducedMotion}
              onClick={() => setMotionPaused((current) => !current)}
              type="button"
            >
              {reducedMotion
                ? "Motion paused"
                : motionPaused
                  ? "Resume motion"
                  : "Pause motion"}
            </button>
            <button
              className="story-visualisation__control story-visualisation__control--accent"
              disabled={loading || Boolean(error) || items.length < 2}
              onClick={shuffle}
              type="button"
            >
              Shuffle stories
              <span aria-hidden="true" className="story-visualisation__control-mark">↻</span>
            </button>
          </div>
        </section>

        {loading ? (
          <div aria-live="polite" className="story-visualisation__state" role="status">
            <p className="story-visualisation__state-title">Gathering your stories…</p>
            <p>The story you were working on remains unchanged.</p>
          </div>
        ) : null}

        {!loading && error ? (
          <div className="story-visualisation__state" role="alert">
            <p className="story-visualisation__state-title">Your stories could not be gathered yet.</p>
            <p>{error}</p>
            <button className="story-visualisation__retry" onClick={onRetry} type="button">
              Try again
            </button>
          </div>
        ) : null}

        {!loading && !error && items.length === 0 ? (
          <div className="story-visualisation__state">
            <p className="story-visualisation__state-title">No saved stories yet</p>
            <p>Stories you keep will appear here when you return.</p>
          </div>
        ) : null}

        {!loading && !error && items.length > 0 ? (
          <section
            aria-describedby={`${id}-meaning-note`}
            aria-label="A changing arrangement of your saved stories"
            className="story-drift"
          >
            <div aria-hidden="true" className="story-drift__orbit story-drift__orbit--one" />
            <div aria-hidden="true" className="story-drift__orbit story-drift__orbit--two" />
            {lanes.map((lane, laneIndex) => (
              <div className={`story-drift__lane story-drift__lane--${laneIndex + 1}`} key={laneIndex}>
                <div className="story-drift__track">
                  <ul className="story-drift__sequence">
                    {lane.map((item) => (
                      <li className="story-drift__item" key={item.id}>
                        <StoryFragment
                          interactive
                          item={item}
                          onSelect={setSelectedStoryId}
                        />
                      </li>
                    ))}
                  </ul>
                  <div aria-hidden="true" className="story-drift__sequence">
                    {lane.map((item) => (
                      <StoryFragment interactive={false} item={item} key={`${item.id}-echo`} />
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </section>
        ) : null}

        <p className="story-visualisation__meaning-note" id={`${id}-meaning-note`}>
          Order and placement do not suggest a connection between stories.
        </p>
        <p aria-live="polite" className="visually-hidden">
          {shuffleAnnouncement}
        </p>
      </main>

      {selectedStory ? (
        <ModalDialog
          describedBy={`${id}-focus-description`}
          labelledBy={`${id}-focus-title`}
          onDismiss={() => setSelectedStoryId(null)}
        >
          <article className="story-focus">
            <button
              aria-label="Close focused story"
              className="story-focus__close"
              onClick={() => setSelectedStoryId(null)}
              type="button"
            >
              Close
            </button>
            <p className="story-focus__eyebrow">Story in focus</p>
            <h2 id={`${id}-focus-title`}>{getDisplayTitle(selectedStory)}</h2>
            <p className="story-focus__excerpt" id={`${id}-focus-description`}>
              “{selectedStory.excerpt || "This story does not have a text excerpt yet."}”
            </p>
            <div className="story-focus__metadata">
              <time dateTime={selectedStory.capturedAt}>{formatDate(selectedStory.capturedAt)}</time>
              {formatVoiceDuration(selectedStory.totalVoiceDurationMs) ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{formatVoiceDuration(selectedStory.totalVoiceDurationMs)}</span>
                </>
              ) : null}
            </div>
            <button
              className="story-focus__open"
              onClick={() => {
                setSelectedStoryId(null);
                onOpen(selectedStory.id);
              }}
              type="button"
            >
              Open story
              <span aria-hidden="true" className="story-focus__open-mark">↗</span>
            </button>
          </article>
        </ModalDialog>
      ) : null}
    </div>
  );
}
