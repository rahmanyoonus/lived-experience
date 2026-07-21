import { StoryVisualisation } from "../components/StoryVisualisation";

const syntheticStories = [
  {
    id: "preview-bicycle-shop",
    title: "Before the bicycle shop opened",
    capturedAt: "2026-05-14T06:20:00.000Z",
    updatedAt: "2026-07-02T08:10:00.000Z",
    excerpt:
      "My grandfather lifted the shutters while I arranged the tools, and the street smelled of rain and strong tea.",
    totalVoiceDurationMs: 434_000,
  },
  {
    id: "preview-ferry",
    title: "The last ferry home",
    capturedAt: "2025-12-03T17:45:00.000Z",
    updatedAt: "2026-01-12T09:30:00.000Z",
    excerpt:
      "The river was almost silver that evening, and everyone grew quiet as the town disappeared behind us.",
    totalVoiceDurationMs: 276_000,
  },
  {
    id: "preview-kitchen-table",
    title: "Lessons around the kitchen table",
    capturedAt: "2026-06-22T20:05:00.000Z",
    updatedAt: "2026-06-22T20:40:00.000Z",
    excerpt:
      "We never called them lessons, but that was where I learnt how patience sounds when someone is trying again.",
    totalVoiceDurationMs: null,
  },
  {
    id: "preview-radio",
    title: "A radio beneath the cedar trees",
    capturedAt: "2024-09-09T14:15:00.000Z",
    updatedAt: "2026-04-19T11:00:00.000Z",
    excerpt:
      "Music travelled across the garden in broken pieces while we waited for the afternoon rain to begin.",
    totalVoiceDurationMs: 188_000,
  },
  {
    id: "preview-first-day",
    title: "Beginning again in a new town",
    capturedAt: "2026-03-08T07:30:00.000Z",
    updatedAt: "2026-03-11T16:20:00.000Z",
    excerpt:
      "I arrived with two boxes, a borrowed map and the feeling that everyone else already knew where they belonged.",
    totalVoiceDurationMs: 502_000,
  },
  {
    id: "preview-clock",
    title: "The clock above the harbour",
    capturedAt: "2025-07-17T10:10:00.000Z",
    updatedAt: "2026-02-01T13:25:00.000Z",
    excerpt:
      "For three mornings the clockmaker listened without touching a tool, waiting for the smallest wheel to reveal itself.",
    totalVoiceDurationMs: 339_000,
  },
] as const;

export function StoryVisualisationPreview() {
  return (
    <StoryVisualisation
      error={null}
      items={syntheticStories}
      loading={false}
      onDismiss={() => undefined}
      onOpen={() => undefined}
      onRetry={() => undefined}
    />
  );
}
