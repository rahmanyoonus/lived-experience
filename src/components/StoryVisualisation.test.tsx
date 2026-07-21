import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  StoryVisualisation,
  type StoryVisualisationProps,
} from "./StoryVisualisation";

const stories = [
  {
    id: "harbour-clock",
    title: "Repairing the harbour clock",
    capturedAt: "2026-07-18T09:30:00.000Z",
    updatedAt: "2026-07-19T12:00:00.000Z",
    excerpt: "A fictional clockmaker listened for the smallest brass wheel.",
    totalVoiceDurationMs: 365_000,
  },
  {
    id: "paper-lighthouse",
    title: "The cardboard lighthouse",
    capturedAt: "2026-06-02T10:00:00.000Z",
    updatedAt: "2026-06-02T11:00:00.000Z",
    excerpt: "A fictional walk passed a lighthouse made from folded paper.",
    totalVoiceDurationMs: null,
  },
  {
    id: "garden-radio",
    title: "The radio in the garden",
    capturedAt: "2025-11-14T13:00:00.000Z",
    updatedAt: "2026-01-04T08:00:00.000Z",
    excerpt: "A fictional gardener heard distant music between the cedar trees.",
    totalVoiceDurationMs: 84_000,
  },
] as const;

function makeProps(
  overrides: Partial<StoryVisualisationProps> = {},
): StoryVisualisationProps {
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("StoryVisualisation", () => {
  it("presents a private non-chronological story arrangement with one accessible control per story", () => {
    render(<StoryVisualisation {...makeProps()} />);

    expect(
      screen.getByRole("heading", { name: "Visualise my stories" }),
    ).toBeVisible();
    expect(screen.getByText("Private to you")).toBeVisible();
    expect(
      screen.getByText(
        "Order and placement do not suggest a connection between stories.",
      ),
    ).toBeVisible();
    expect(screen.getAllByRole("button", { name: /^Explore / })).toHaveLength(
      stories.length,
    );
    expect(screen.queryByText(/category|theme|score|progress/i)).not.toBeInTheDocument();
  });

  it("pauses and resumes motion explicitly, then announces a shuffle without losing stories", async () => {
    const user = userEvent.setup();
    render(<StoryVisualisation {...makeProps()} />);

    const pause = screen.getByRole("button", { name: "Pause motion" });
    expect(pause).toHaveAttribute("aria-pressed", "false");
    await user.click(pause);
    expect(
      screen.getByRole("button", { name: "Resume motion" }),
    ).toHaveAttribute("aria-pressed", "true");

    const shuffle = screen.getByRole("button", { name: "Shuffle stories" });
    await user.click(shuffle);
    expect(shuffle).toHaveFocus();
    expect(screen.getByText("Stories rearranged.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Explore / })).toHaveLength(
      stories.length,
    );
  });

  it("focuses a selected story and opens it by its stable id", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<StoryVisualisation {...makeProps({ onOpen })} />);

    await user.click(
      screen.getByRole("button", {
        name: "Explore Repairing the harbour clock",
      }),
    );

    const dialog = screen.getByRole("dialog", {
      name: "Repairing the harbour clock",
    });
    expect(dialog).toHaveTextContent(
      "A fictional clockmaker listened for the smallest brass wheel.",
    );
    expect(within(dialog).getByText("Voice · 6 min")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Open story" }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith("harbour-clock");
  });

  it("starts static when reduced motion is requested", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );

    render(<StoryVisualisation {...makeProps()} />);
    expect(screen.getByRole("button", { name: "Motion paused" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Motion paused" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps loading, retryable failure, and empty states calm and explicit", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = render(
      <StoryVisualisation {...makeProps({ items: [], loading: true, onRetry })} />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Gathering your stories…");

    rerender(
      <StoryVisualisation
        {...makeProps({
          items: [],
          error: "Your private stories could not be loaded yet.",
          onRetry,
        })}
      />,
    );
    const alert = screen.getByRole("alert");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();

    rerender(<StoryVisualisation {...makeProps({ items: [] })} />);
    expect(screen.getByText("No saved stories yet")).toBeVisible();
    expect(
      screen.getByText("Stories you keep will appear here when you return."),
    ).toBeVisible();
  });

  it("returns to the capture surface from the first focused control", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<StoryVisualisation {...makeProps({ onDismiss })} />);

    const back = screen.getByRole("button", { name: "Back to your story" });
    expect(back).toHaveFocus();
    await user.click(back);
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
