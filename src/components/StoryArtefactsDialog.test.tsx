import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  StoryArtefactsDialog,
  type StoryArtefactsDialogProps,
} from "./StoryArtefactsDialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeProps(
  overrides: Partial<StoryArtefactsDialogProps> = {},
): StoryArtefactsDialogProps {
  return {
    mode: "audio",
    audioItems: [],
    transcriptItems: [],
    versions: [],
    onPlayUncertainty: vi.fn(),
    onRestoreVersion: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
}

describe("StoryArtefactsDialog", () => {
  it("renders labelled native controls for each supplied original recording", () => {
    render(
      <StoryArtefactsDialog
        {...makeProps({
          audioItems: [
            {
              id: "audio-one",
              recordedAt: "2026-07-19T01:00:00.000Z",
              durationMs: 65_000,
              parts: [
                {
                  src: "https://example.test/private/audio-one.webm",
                  startOffsetMs: 0,
                  durationMs: 65_000,
                },
              ],
            },
          ],
        })}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Original audio" }),
    ).toHaveAccessibleDescription(
      "Listen to the recordings that remain the source of truth for what was spoken.",
    );
    const player = screen.getByLabelText("Play original recording 1");
    expect(player).toBeInstanceOf(HTMLAudioElement);
    expect(player).toHaveAttribute("controls");
    expect(player).toHaveAttribute("preload", "metadata");
    expect(player).toHaveAttribute(
      "src",
      "https://example.test/private/audio-one.webm",
    );
    expect(screen.getByText("1 min 5 sec")).toBeVisible();
  });

  it("shows one recording card and continues across its internal parts", async () => {
    const load = vi
      .spyOn(HTMLMediaElement.prototype, "load")
      .mockImplementation(() => undefined);
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    render(
      <StoryArtefactsDialog
        {...makeProps({
          audioItems: [
            {
              id: "logical-segment",
              recordedAt: "2026-07-19T01:00:00.000Z",
              durationMs: 2_000,
              parts: [
                {
                  src: "https://example.test/private/part-one.webm",
                  startOffsetMs: 0,
                  durationMs: 1_000,
                },
                {
                  src: "https://example.test/private/part-two.webm",
                  startOffsetMs: 1_000,
                  durationMs: 1_000,
                },
              ],
            },
          ],
        })}
      />,
    );

    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Recording 1" })).toBeVisible();
    expect(screen.queryByText(/part 1|part 2/i)).not.toBeInTheDocument();
    const player = screen.getByLabelText("Play original recording 1");
    expect(player).toHaveAttribute(
      "src",
      "https://example.test/private/part-one.webm",
    );
    player.dispatchEvent(new Event("ended", { bubbles: true }));
    await screen.findByLabelText("Play original recording 1");
    expect(player).toHaveAttribute(
      "src",
      "https://example.test/private/part-two.webm",
    );
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(play).toHaveBeenCalled();
  });

  it("preserves transcript text and replays only supplied uncertain ranges", async () => {
    const user = userEvent.setup();
    const onPlayUncertainty = vi.fn();
    const transcriptText = "Um, I  might\nremember.";
    render(
      <StoryArtefactsDialog
        {...makeProps({
          mode: "transcript",
          onPlayUncertainty,
          transcriptItems: [
            {
              id: "transcript-one",
              createdAt: "2026-07-19T01:01:00.000Z",
              text: transcriptText,
              audioId: "audio-one",
              uncertainties: [
                {
                  start: 7,
                  end: 12,
                  audioStartMs: 1_100,
                  audioEndMs: 1_900,
                  confidence: 0.72,
                },
                {
                  start: 13,
                  end: 21,
                  audioStartMs: 2_200,
                  audioEndMs: 3_400,
                },
              ],
            },
          ],
        })}
      />,
    );

    const verbatim = screen.getByLabelText("Verbatim text of transcript 1");
    expect(verbatim.textContent).toBe(transcriptText);
    expect(screen.getByText("might")).toBeVisible();
    expect(screen.getByText("remember")).toBeVisible();
    expect(screen.getByText(/72% transcription confidence/)).toBeVisible();

    expect(screen.getAllByText("Review this part")).toHaveLength(2);
    const replayActions = screen.getAllByRole("button", {
      name: /Play audio part .* to review/,
    });
    expect(replayActions).toHaveLength(2);
    const secondReplay = replayActions.at(1);
    expect(secondReplay).toBeDefined();
    if (!secondReplay) {
      throw new Error("Expected a second supplied uncertainty replay action.");
    }
    await user.click(secondReplay);
    expect(onPlayUncertainty).toHaveBeenCalledOnce();
    expect(onPlayUncertainty).toHaveBeenCalledWith("audio-one", 2_200);
  });

  it("does not invent uncertainty controls when none were supplied", () => {
    render(
      <StoryArtefactsDialog
        {...makeProps({
          mode: "transcript",
          transcriptItems: [
            {
              id: "transcript-one",
              createdAt: "2026-07-19T01:01:00.000Z",
              text: "A wholly fictional transcript.",
              audioId: "audio-one",
              uncertainties: [],
            },
          ],
        })}
      />,
    );

    expect(
      screen.getByText(
        "No uncertain passages were supplied for this transcript.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Play audio part .* to review/ }),
    ).not.toBeInTheDocument();
  });

  it("shows recoverable snapshots and restores by stable version id", async () => {
    const user = userEvent.setup();
    const onRestoreVersion = vi.fn();
    const versionText = "First line.\n\nA second, fictional paragraph.";
    render(
      <StoryArtefactsDialog
        {...makeProps({
          mode: "versions",
          onRestoreVersion,
          versions: [
            {
              id: "version-one",
              createdAt: "2026-07-19T01:02:00.000Z",
              reason: "meaningful-edit",
              text: versionText,
            },
          ],
        })}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Version history" }),
    ).toHaveAccessibleDescription(
      "Earlier edits remain recoverable. Restoring one adds a new current version and does not erase later work.",
    );
    const version = screen.getByRole("article");
    expect(within(version).getByText("Meaningful edit")).toBeVisible();
    expect(within(version).getByLabelText("Text of version 1").textContent).toBe(
      versionText,
    );

    await user.click(
      within(version).getByRole("button", { name: "Restore version 1" }),
    );
    expect(onRestoreVersion).toHaveBeenCalledOnce();
    expect(onRestoreVersion).toHaveBeenCalledWith("version-one");
  });

  it("identifies both conflict candidates without making a choice", async () => {
    const user = userEvent.setup();
    const onRestoreVersion = vi.fn();
    render(
      <StoryArtefactsDialog
        {...makeProps({
          mode: "versions",
          onRestoreVersion,
          versions: [
            {
              id: "device-version",
              createdAt: "2026-07-19T01:02:00.000Z",
              reason: "conflict-choice",
              text: "A fictional device copy mentioned a green lantern.",
              conflictRole: "device",
            },
            {
              id: "account-version",
              createdAt: "2026-07-19T01:03:00.000Z",
              reason: "cloud-sync",
              text: "A fictional account copy mentioned a blue lantern.",
              conflictRole: "account",
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("This device’s version")).toBeVisible();
    expect(screen.getByText("Account-saved version")).toBeVisible();
    expect(onRestoreVersion).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", {
        name: "Use account-saved version 2",
      }),
    );
    expect(onRestoreVersion).toHaveBeenCalledOnce();
    expect(onRestoreVersion).toHaveBeenCalledWith("account-version");
  });

  it("uses a mode-specific calm empty state", () => {
    render(
      <StoryArtefactsDialog {...makeProps({ mode: "transcript" })} />,
    );

    expect(
      screen.getByText(
        "No original transcripts are available for this story.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /replay/i })).not.toBeInTheDocument();
  });

  it("focuses Close, includes native audio in the focus trap, and dismisses with Escape", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <StoryArtefactsDialog
        {...makeProps({
          onDismiss,
          audioItems: [
            {
              id: "audio-one",
              recordedAt: "2026-07-19T01:00:00.000Z",
              durationMs: 1_000,
              parts: [
                {
                  src: "https://example.test/private/audio-one.webm",
                  startOffsetMs: 0,
                  durationMs: 1_000,
                },
              ],
            },
          ],
        })}
      />,
    );

    const close = screen.getByRole("button", {
      name: "Close originals and history",
    });
    const player = screen.getByLabelText("Play original recording 1");
    expect(close).toHaveFocus();

    await user.tab();
    expect(player).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
