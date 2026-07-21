import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CaptureCanvas,
  EXAMPLE_STORY_TEXT,
  type CaptureCanvasProps,
} from "./CaptureCanvas";

afterEach(cleanup);

function makeProps(
  overrides: Partial<CaptureCanvasProps> = {},
): CaptureCanvasProps {
  return {
    content: "",
    phase: "empty",
    persistenceState: "idle",
    hasStarted: false,
    isAuthenticated: false,
    onContentChange: vi.fn(),
    onStartRecording: vi.fn(),
    onStopRecording: vi.fn(),
    ...overrides,
  };
}

describe("CaptureCanvas", () => {
  it("opens directly to an editable story with Just listen selected", () => {
    render(<CaptureCanvas {...makeProps()} />);

    expect(
      screen.getByRole("heading", { name: "Start whenever you’re ready." }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/speak or write in your own words/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Write or edit your story" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /Just listen\s*On/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", {
        name: /Guide me\s*Not yet available/,
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: /Give me a prompt\s*Not yet available/,
      }),
    ).toBeDisabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers fictional example text only on an untouched canvas", async () => {
    const user = userEvent.setup();
    const onContentChange = vi.fn();
    const { rerender } = render(
      <CaptureCanvas {...makeProps({ onContentChange })} />,
    );

    expect(
      screen.getByText("Adds a fictional sample you can edit or replace."),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Use example text" }),
    );
    expect(onContentChange).toHaveBeenCalledOnce();
    expect(onContentChange).toHaveBeenCalledWith(EXAMPLE_STORY_TEXT);

    rerender(
      <CaptureCanvas
        {...makeProps({
          content: EXAMPLE_STORY_TEXT,
          hasStarted: true,
          onContentChange,
          phase: "editing",
        })}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Use example text" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the private library out of the guest capture flow", async () => {
    const user = userEvent.setup();
    const onOpenStories = vi.fn();
    const { rerender } = render(<CaptureCanvas {...makeProps()} />);

    expect(
      screen.queryByRole("button", { name: "Your stories" }),
    ).not.toBeInTheDocument();

    rerender(
      <CaptureCanvas
        {...makeProps({ isAuthenticated: true, onOpenStories })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Your stories" }));
    expect(onOpenStories).toHaveBeenCalledOnce();
  });

  it("shows restrained recording activity, elapsed time, and an explicit stop", () => {
    const { container } = render(
      <CaptureCanvas
        {...makeProps({
          phase: "recording",
          hasStarted: true,
          persistenceState: "saved-locally",
          recordingDurationSeconds: 65,
          onKeepStory: vi.fn(),
        })}
      />,
    );

    expect(screen.getByText("Listening")).toBeInTheDocument();
    expect(
      screen.getByRole("timer", {
        name: "Recording duration 1 minute, 5 seconds",
      }),
    ).toHaveTextContent("01:05");
    expect(
      screen.getByRole("button", { name: "Stop recording" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Keep this story" }),
    ).toBeDisabled();
    expect(container.querySelector(".recording-wave")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(container.querySelector(".recording-wave__line")).toBeInTheDocument();
  });

  it("allows writing but blocks another recording during transcription", () => {
    const onContentChange = vi.fn();
    render(
      <CaptureCanvas
        {...makeProps({
          phase: "processing",
          hasStarted: true,
          onContentChange,
        })}
      />,
    );

    const editor = screen.getByRole("textbox", {
      name: "Write or edit your story",
    });
    fireEvent.change(editor, { target: { value: "I kept writing." } });

    expect(onContentChange).toHaveBeenCalledWith("I kept writing.");
    expect(editor).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Preparing transcript" }),
    ).toBeDisabled();
    expect(
      screen.getByText(/another recording will be available when it is ready/i),
    ).toBeInTheDocument();
  });

  it("uses explicit persistence wording for device-only and cloud saves", () => {
    const { rerender } = render(
      <CaptureCanvas
        {...makeProps({
          hasStarted: true,
          persistenceState: "saved-locally",
        })}
      />,
    );

    expect(screen.getByText("Saved locally")).toBeInTheDocument();
    expect(
      screen.getByText("Only on this device"),
    ).toBeInTheDocument();

    rerender(
      <CaptureCanvas
        {...makeProps({
          hasStarted: true,
          isAuthenticated: true,
          persistenceState: "saved",
        })}
      />,
    );

    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByText("Private in your account")).toBeInTheDocument();

    rerender(
      <CaptureCanvas
        {...makeProps({
          hasStarted: true,
          persistenceState: "sync-error",
        })}
      />,
    );

    expect(
      screen.getByText(
        "Keep this page open; your latest changes may not be saved yet",
      ),
    ).toBeInTheDocument();
  });

  it("offers an explicit sync action only for account changes waiting to sync", async () => {
    const user = userEvent.setup();
    const onSyncNow = vi.fn();
    const { rerender } = render(
      <CaptureCanvas
        {...makeProps({
          hasStarted: true,
          isAuthenticated: true,
          onSyncNow,
          persistenceState: "not-yet-synced",
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Sync now" }));
    expect(onSyncNow).toHaveBeenCalledOnce();

    rerender(
      <CaptureCanvas
        {...makeProps({
          hasStarted: true,
          isAuthenticated: true,
          onSyncNow,
          persistenceState: "saved",
        })}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Sync now" }),
    ).not.toBeInTheDocument();
  });

  it("explains microphone permission before recording", async () => {
    const user = userEvent.setup();
    const onConfirmMicrophone = vi.fn();
    const onDismissMicrophone = vi.fn();
    render(
      <CaptureCanvas
        {...makeProps({
          microphoneDialog: "explanation",
          onConfirmMicrophone,
          onDismissMicrophone,
        })}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Use your microphone?" }),
    ).toHaveTextContent("stops only when you choose Stop recording");
    await user.click(
      screen.getByRole("button", { name: "Allow and start" }),
    );
    expect(onConfirmMicrophone).toHaveBeenCalledOnce();
  });

  it("offers passwordless email continuation without hiding the active story", async () => {
    const user = userEvent.setup();
    const onSendMagicLink = vi.fn().mockResolvedValue({ ok: true });
    render(
      <CaptureCanvas
        {...makeProps({
          content: "A fictional afternoon by the sea.",
          emailDialogOpen: true,
          hasStarted: true,
          onSendMagicLink,
          onDismissEmailDialog: vi.fn(),
        })}
      />,
    );

    expect(
      screen.getByRole("textbox", { name: "Write or edit your story" }),
    ).toHaveValue("A fictional afternoon by the sea.");
    expect(
      screen.getByRole("dialog", { name: "Keep this story" }),
    ).toHaveTextContent("saved only in this browser on this device");

    await user.type(
      screen.getByRole("textbox", { name: "Email address" }),
      "person@example.test",
    );
    await user.click(
      screen.getByRole("button", { name: "Email me a link" }),
    );
    expect(onSendMagicLink).toHaveBeenCalledWith("person@example.test");
    expect(await screen.findByText(/check your email/i)).toBeInTheDocument();
  });

  it("discloses when email continuation is not configured", () => {
    render(
      <CaptureCanvas
        {...makeProps({
          content: "A fictional afternoon by the sea.",
          emailSignInAvailable: false,
          emailDialogOpen: true,
          hasStarted: true,
          onSendMagicLink: vi.fn(),
          onDismissEmailDialog: vi.fn(),
          onKeepStory: vi.fn(),
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Email sign-in unavailable" }),
    ).toBeDisabled();
    expect(screen.getByRole("dialog", { name: "Keep this story" })).toHaveTextContent(
      "Email sign-in isn’t connected in this environment yet",
    );
  });

  it("offers a direct Version history action when a cloud conflict needs a choice", async () => {
    const user = userEvent.setup();
    const onReviewConflictVersions = vi.fn();
    render(
      <CaptureCanvas
        {...makeProps({
          captureMessage:
            "This story was changed elsewhere. Both versions are safe.",
          hasStarted: true,
          hasVersionHistory: true,
          isAuthenticated: true,
          onOpenVersionHistory: vi.fn(),
          onReviewConflictVersions,
          persistenceState: "not-yet-synced",
        })}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Both versions are safe",
    );
    await user.click(
      screen.getByRole("button", { name: "Review versions" }),
    );
    expect(onReviewConflictVersions).toHaveBeenCalledOnce();
  });
});
