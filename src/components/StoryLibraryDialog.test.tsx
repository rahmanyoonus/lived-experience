import {
  cleanup,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  StoryLibraryDialog,
  type StoryLibraryDialogProps,
  type StoryLibraryItem,
} from "./StoryLibraryDialog";

afterEach(cleanup);

const stories: readonly StoryLibraryItem[] = [
  {
    id: "newest-story",
    title: "Repairing the harbour clock",
    capturedAt: "2026-07-19T09:00:00",
    updatedAt: "2026-07-19T09:10:00",
    excerpt: "Um, the fictional clock ticked twice beside the quiet harbour.",
    totalVoiceDurationMs: 65_000,
  },
  {
    id: "older-story",
    title: null,
    capturedAt: "2026-07-18T10:30:00",
    updatedAt: "2026-07-18T10:30:00",
    excerpt: "A fictional walk past a cardboard lighthouse.",
    totalVoiceDurationMs: null,
  },
];

function makeProps(
  overrides: Partial<StoryLibraryDialogProps> = {},
): StoryLibraryDialogProps {
  return {
    items: stories,
    loading: false,
    error: null,
    onOpen: vi.fn(),
    onRetry: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
}

describe("StoryLibraryDialog", () => {
  it("shows caller-ordered recognition details without organisational extras", () => {
    render(<StoryLibraryDialog {...makeProps()} />);

    expect(
      screen.getByRole("dialog", { name: "Your stories" }),
    ).toHaveAccessibleDescription(
      "Open a private story to continue it in the capture canvas.",
    );

    const cards = screen.getAllByRole("article");
    const newestCard = cards[0];
    const olderCard = cards[1];

    expect(cards).toHaveLength(2);
    expect(newestCard).toBeDefined();
    expect(olderCard).toBeDefined();

    if (!newestCard || !olderCard) {
      throw new Error("Expected two story cards");
    }

    expect(
      within(newestCard).getByRole("heading", {
        name: "Repairing the harbour clock",
      }),
    ).toBeInTheDocument();
    expect(within(newestCard).getByText("Voice · 1 min 5 sec")).toBeVisible();
    expect(
      within(newestCard).getByText(
        "Um, the fictional clock ticked twice beside the quiet harbour.",
      ),
    ).toBeVisible();

    expect(
      within(olderCard).getByRole("heading", {
        name: "18 Jul 2026 — A fictional walk past a cardboard lighthouse.",
      }),
    ).toBeInTheDocument();
    expect(within(olderCard).getByText("No voice recording")).toBeVisible();
    expect(
      within(olderCard).getByText(
        "A fictional walk past a cardboard lighthouse.",
      ),
    ).toBeVisible();

    expect(screen.queryByText(/categor|score|summary|progress/i)).not.toBeInTheDocument();
  });

  it("opens the selected story by its stable id", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<StoryLibraryDialog {...makeProps({ onOpen })} />);

    await user.click(
      screen.getByRole("button", {
        name: "Open Repairing the harbour clock",
      }),
    );

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith("newest-story");
  });

  it("keeps loading and content-free error states explicit and retryable", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = render(
      <StoryLibraryDialog
        {...makeProps({ items: [], loading: true, onRetry })}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading your stories…",
    );
    expect(screen.queryByRole("list", { name: "Your saved stories" })).not.toBeInTheDocument();

    rerender(
      <StoryLibraryDialog
        {...makeProps({
          items: [],
          error: "Your stories could not be loaded.",
          onRetry,
        })}
      />,
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your stories could not be loaded.",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("uses a calm empty state without creating completion pressure", () => {
    render(<StoryLibraryDialog {...makeProps({ items: [] })} />);

    expect(screen.getByText("No saved stories yet")).toBeVisible();
    expect(screen.getByText("Stories you keep will appear here.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /start|create/i })).not.toBeInTheDocument();
  });

  it("focuses the close action, traps Tab, and dismisses with Escape", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <StoryLibraryDialog
        {...makeProps({ items: [], onDismiss })}
      />,
    );

    const closeButton = screen.getByRole("button", {
      name: "Close your stories",
    });
    expect(closeButton).toHaveFocus();

    await user.tab();
    expect(closeButton).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
