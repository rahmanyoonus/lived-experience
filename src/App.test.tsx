import Dexie from "dexie";
import type { Session } from "@supabase/supabase-js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { EXAMPLE_STORY_TEXT } from "./components";
import {
  createGuestPersistence,
  type GuestPersistence,
  type RecoveredGuestDraft,
} from "./data";
import {
  CloudStoryEditConflictError,
  type CloudPersistence,
  type CloudStory,
} from "./services/cloudPersistence";
import type { AuthReturnContext } from "./services/auth";
import { MicrophoneFailure, type ChunkedRecorderOptions } from "./services/recorder";
import {
  TranscriptionError,
  type TranscriptionResult,
} from "./services/transcription";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

const databases: Array<{ name: string; persistence: GuestPersistence }> = [];

function testPersistence(): GuestPersistence {
  const name = `lived-experience-app-${crypto.randomUUID()}`;
  const persistence = createGuestPersistence({ databaseName: name });
  databases.push({ name, persistence });
  return persistence;
}

afterEach(async () => {
  cleanup();
  for (const database of databases.splice(0)) {
    database.persistence.close();
    await Dexie.delete(database.name);
  }
});

describe("App capture integration", () => {
  it("keeps a healthy readiness check completely out of the interface", async () => {
    const persistence = testPersistence();
    render(
      <App
        dependencies={{
          persistence,
          checkDeviceReadiness: () => Promise.resolve({ status: "ready" }),
          checkTranscriptionReadiness: () =>
            Promise.resolve({ status: "ready" }),
        }}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("textbox", { name: "Write or edit your story" }),
      ).toBeEnabled();
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/system.*ready/i)).not.toBeInTheDocument();
  });

  it("blocks writing and recording when device storage cannot be verified", async () => {
    const persistence = testPersistence();
    render(
      <App
        dependencies={{
          persistence,
          checkDeviceReadiness: () =>
            Promise.resolve({
              status: "blocked",
              reason: "device-storage-unavailable",
            }),
          checkTranscriptionReadiness: () =>
            Promise.resolve({ status: "ready" }),
        }}
      />,
    );

    expect(
      await screen.findByText(/cannot safely save a story/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Write or edit your story" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Start recording" }),
    ).toBeDisabled();
    await expect(persistence.recoverGuestDraft()).resolves.toBeNull();
  });

  it("warns about cloud trouble while leaving device-safe capture available", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    render(
      <App
        dependencies={{
          persistence,
          isCloudConfigured: () => true,
          completeEmailMagicLinkReturn: () => Promise.resolve(),
          getCurrentSession: () => Promise.resolve(null),
          onAuthStateChange: () => () => undefined,
          checkDeviceReadiness: () => Promise.resolve({ status: "ready" }),
          checkCloudReadiness: () =>
            Promise.resolve({
              status: "degraded",
              reason: "cloud-unavailable",
            }),
          checkTranscriptionReadiness: () =>
            Promise.resolve({ status: "ready" }),
        }}
      />,
    );

    expect(
      await screen.findByText(/Cloud saving is temporarily unavailable/i),
    ).toBeInTheDocument();
    const editor = screen.getByRole("textbox", {
      name: "Write or edit your story",
    });
    expect(editor).toBeEnabled();
    await user.type(editor, "A fictional safe local sentence.");
    await screen.findByText("Saved locally");
  });

  it("warns about delayed transcription only after voice capture is selected", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    render(
      <App
        dependencies={{
          persistence,
          checkDeviceReadiness: () => Promise.resolve({ status: "ready" }),
          checkTranscriptionReadiness: () =>
            Promise.resolve({ status: "degraded" }),
        }}
      />,
    );

    expect(
      screen.queryByText(/transcription may be delayed/i),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    expect(
      await screen.findByText(/transcription may be delayed/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Allow and start" }),
    ).toBeEnabled();
  });

  it("opens immediately and acknowledges typed guest content locally", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    render(<App dependencies={{ persistence }} />);

    const editor = screen.getByRole("textbox", {
      name: "Write or edit your story",
    });
    await user.type(
      editor,
      "On a fictional morning, Nura found a blue paper boat.",
    );

    await waitFor(() => {
      expect(screen.getByText("Saved locally")).toBeInTheDocument();
    });
    expect((await persistence.recoverGuestDraft())?.story.current_text).toBe(
      "On a fictional morning, Nura found a blue paper boat.",
    );
  });

  it("fills and saves the fictional judge example without replacing existing work", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    render(<App dependencies={{ persistence }} />);

    await user.click(
      screen.getByRole("button", { name: "Use example text" }),
    );

    const editor = screen.getByRole("textbox", {
      name: "Write or edit your story",
    });
    expect(editor).toHaveValue(EXAMPLE_STORY_TEXT);
    expect(
      screen.queryByRole("button", { name: "Use example text" }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Saved locally")).toBeInTheDocument();
    });
    expect((await persistence.recoverGuestDraft())?.story.current_text).toBe(
      EXAMPLE_STORY_TEXT,
    );
  });

  it("preserves both recovered work and typing that begins before recovery finishes", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    const recoveredText = "A fictional old draft about a copper kite.";
    const immediateText = "A new sentence written as the page opened.";
    await persistence.saveText({ current_text: recoveredText });
    const recovered = await persistence.recoverGuestDraft();
    const recovery = deferred<RecoveredGuestDraft | null>();
    vi.spyOn(persistence, "recoverGuestDraft").mockReturnValueOnce(
      recovery.promise,
    );

    render(<App dependencies={{ persistence }} />);
    const editor = screen.getByRole("textbox", {
      name: "Write or edit your story",
    });
    await user.type(editor, immediateText);
    recovery.resolve(recovered);

    const preserved = `${recoveredText}\n\n${immediateText}`;
    await waitFor(() => expect(editor).toHaveValue(preserved));
    await waitFor(() => {
      expect(screen.getByText("Saved locally")).toBeInTheDocument();
    });
    expect((await persistence.recoverGuestDraft())?.story.current_text).toBe(
      preserved,
    );
  });

  it("keeps typing available during processing and adds the transcript only when ready", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    const transcription = deferred<TranscriptionResult>();
    let recorderOptions: ChunkedRecorderOptions | null = null;

    render(
      <App
        dependencies={{
          persistence,
          createRecorder: (options) => {
            recorderOptions = options;
            return {
              start: () => Promise.resolve("audio/webm"),
              stop: async () => {
                const blob = new Blob(["synthetic-audio"], {
                  type: "audio/webm",
                });
                await options.onChunk({
                  blob,
                  byteSize: blob.size,
                  mediaType: blob.type,
                  sequenceNumber: 1,
                });
                return {
                  blob,
                  byteSize: blob.size,
                  durationMs: 1_200,
                  mediaType: blob.type,
                  chunks: [],
                  stoppedAtLimit: false,
                  persistenceAcknowledged: true,
                };
              },
            };
          },
          transcribe: () => transcription.promise,
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(
      screen.getByRole("button", { name: "Allow and start" }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Stop recording" }),
      ).toBeEnabled();
    });
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    expect(recorderOptions).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Stop recording" }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Preparing transcript" }),
      ).toBeDisabled();
    });
    expect(screen.queryByText("I, um, kept the red key.")).not.toBeInTheDocument();

    const editor = screen.getByRole("textbox", {
      name: "Write or edit your story",
    });
    await user.type(editor, "I can keep writing meanwhile.");
    transcription.resolve({
      text: "I, um, kept the red key.",
      provider: "synthetic-openai-test",
      model: "synthetic-whisper-test",
      language: "en",
      uncertainties: [],
    });

    await waitFor(() => {
      expect(editor).toHaveValue(
        "I, um, kept the red key.\n\nI can keep writing meanwhile.",
      );
    });
    await waitFor(async () => {
      const recovered = await persistence.recoverGuestDraft();
      expect(recovered?.original_transcripts).toHaveLength(1);
      expect(recovered?.transcript_applications).toHaveLength(1);
      expect(recovered?.story_versions).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect((await persistence.recoverGuestDraft())?.story.current_text).toBe(
      "I, um, kept the red key.\n\nI can keep writing meanwhile.",
    );
  });

  it("preserves typing entered while the completed transcript is committed locally", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    const applicationGate = deferred<void>();
    const applyOriginalTranscript =
      persistence.applyOriginalTranscript.bind(persistence);
    const applySpy = vi
      .spyOn(persistence, "applyOriginalTranscript")
      .mockImplementation(async (input) => {
        await applicationGate.promise;
        return applyOriginalTranscript(input);
      });

    render(
      <App
        dependencies={{
          persistence,
          createRecorder: (options) => ({
            start: () => Promise.resolve("audio/webm"),
            stop: async () => {
              const blob = new Blob(["synthetic-commit-audio"], {
                type: "audio/webm",
              });
              await options.onChunk({
                blob,
                byteSize: blob.size,
                mediaType: blob.type,
                sequenceNumber: 1,
              });
              return {
                blob,
                byteSize: blob.size,
                durationMs: 1_100,
                mediaType: blob.type,
                chunks: [],
                stoppedAtLimit: false,
                persistenceAcknowledged: true,
              };
            },
          }),
          transcribe: () =>
            Promise.resolve({
              text: "I waited beside the fictional blue gate.",
              provider: "synthetic-openai-test",
              model: "synthetic-whisper-test",
              language: "en",
              uncertainties: [],
            }),
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(
      screen.getByRole("button", { name: "Allow and start" }),
    );
    await screen.findByRole("button", { name: "Stop recording" });
    await user.click(screen.getByRole("button", { name: "Stop recording" }));
    await waitFor(() => expect(applySpy).toHaveBeenCalledOnce());

    const editor = screen.getByRole("textbox", {
      name: "Write or edit your story",
    });
    await user.type(editor, "I kept writing during the local commit.");
    applicationGate.resolve(undefined);

    const expected =
      "I waited beside the fictional blue gate.\n\nI kept writing during the local commit.";
    await waitFor(() => expect(editor).toHaveValue(expected));
    await waitFor(async () => {
      const recovered = await persistence.recoverGuestDraft();
      expect(recovered?.story.current_text).toBe(expected);
      expect(recovered?.transcript_applications).toHaveLength(1);
      expect(recovered?.story_versions).toHaveLength(1);
    });
  });

  it("does not claim a local save when typing and its transcript fallback both fail", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    const transcription = deferred<TranscriptionResult>();

    render(
      <App
        dependencies={{
          persistence,
          createRecorder: (options) => ({
            start: () => Promise.resolve("audio/webm"),
            stop: async () => {
              const blob = new Blob(["synthetic-save-failure-audio"], {
                type: "audio/webm",
              });
              await options.onChunk({
                blob,
                byteSize: blob.size,
                mediaType: blob.type,
                sequenceNumber: 1,
              });
              return {
                blob,
                byteSize: blob.size,
                durationMs: 1_300,
                mediaType: blob.type,
                chunks: [],
                stoppedAtLimit: false,
                persistenceAcknowledged: true,
              };
            },
          }),
          transcribe: () => transcription.promise,
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(
      screen.getByRole("button", { name: "Allow and start" }),
    );
    await screen.findByRole("button", { name: "Stop recording" });
    await user.click(screen.getByRole("button", { name: "Stop recording" }));
    await screen.findByRole("button", { name: "Preparing transcript" });

    vi.spyOn(persistence, "saveText").mockRejectedValue(
      new Error("synthetic-processing-save-failure"),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Write or edit your story" }),
      "X",
    );
    transcription.resolve({
      text: "A fictional sentence that must not be shown yet.",
      provider: "synthetic-openai-test",
      model: "synthetic-whisper-test",
      language: "en",
      uncertainties: [],
    });

    await screen.findByText("The latest local save was not acknowledged.");
    expect(screen.getByText("Not yet synced")).toBeInTheDocument();
    expect(screen.queryByText("Saved locally")).not.toBeInTheDocument();
    expect(
      screen.queryByDisplayValue(/fictional sentence/),
    ).not.toBeInTheDocument();
  });

  it("offers an in-memory download when ordered chunk recovery is rejected", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    const appendSpy = vi.spyOn(persistence, "appendAudioChunk").mockRejectedValue(
      new Error("synthetic-indexeddb-write-rejection"),
    );
    render(
      <App
        dependencies={{
          persistence,
          createRecorder: (options) => ({
            start: () => Promise.resolve("audio/webm"),
            stop: async () => {
              const blob = new Blob(["in-memory-emergency-audio"], {
                type: "audio/webm",
              });
              const chunk = {
                blob,
                byteSize: blob.size,
                mediaType: blob.type,
                sequenceNumber: 1,
                partSequenceNumber: 1,
                partChunkSequenceNumber: 1,
                partStartOffsetMs: 0,
                partElapsedMs: 600,
              } as const;
              await options.onChunk(chunk).catch(() => undefined);
              return {
                byteSize: blob.size,
                durationMs: 600,
                mediaType: blob.type,
                chunks: [chunk],
                parts: [
                  {
                    blob,
                    byteSize: blob.size,
                    durationMs: 600,
                    mediaType: blob.type,
                    sequenceNumber: 1,
                    startOffsetMs: 0,
                    chunks: [chunk],
                  },
                ],
                stoppedAtLimit: false,
                persistenceAcknowledged: false,
              };
            },
          }),
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(
      screen.getByRole("button", { name: "Allow and start" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Stop recording" }),
    );

    expect(
      await screen.findByRole("button", {
        name: "Download recording backup",
      }),
    ).toBeEnabled();
    expect(screen.getByText("Not yet synced")).toBeInTheDocument();
    expect(screen.queryByText("Saved locally")).not.toBeInTheDocument();
    expect(appendSpy).toHaveBeenCalledTimes(2);
  });

  it("retries one missing in-memory chunk in order before giving up local save", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    const appendAudioChunk = persistence.appendAudioChunk.bind(persistence);
    const appendSpy = vi
      .spyOn(persistence, "appendAudioChunk")
      .mockRejectedValueOnce(new Error("synthetic-transient-write-rejection"))
      .mockImplementation(appendAudioChunk);
    render(
      <App
        dependencies={{
          persistence,
          createRecorder: (options) => ({
            start: () => Promise.resolve("audio/webm"),
            stop: async () => {
              const blob = new Blob(["recoverable-in-memory-audio"], {
                type: "audio/webm",
              });
              const chunk = {
                blob,
                byteSize: blob.size,
                mediaType: blob.type,
                sequenceNumber: 1,
                partSequenceNumber: 1,
                partChunkSequenceNumber: 1,
                partStartOffsetMs: 0,
                partElapsedMs: 650,
              } as const;
              await options.onChunk(chunk).catch(() => undefined);
              return {
                byteSize: blob.size,
                durationMs: 650,
                mediaType: blob.type,
                chunks: [chunk],
                parts: [
                  {
                    blob,
                    byteSize: blob.size,
                    durationMs: 650,
                    mediaType: blob.type,
                    sequenceNumber: 1,
                    startOffsetMs: 0,
                    chunks: [chunk],
                  },
                ],
                stoppedAtLimit: false,
                persistenceAcknowledged: false,
              };
            },
          }),
          transcribe: () =>
            Promise.resolve({
              text: "A fictional recovered recording.",
              provider: "synthetic-openai-test",
              model: "synthetic-model",
              language: "en",
              uncertainties: [],
            }),
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(
      screen.getByRole("button", { name: "Allow and start" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Stop recording" }),
    );

    expect(
      await screen.findByDisplayValue("A fictional recovered recording."),
    ).toBeInTheDocument();
    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: /download recording backup/i }))
      .not.toBeInTheDocument();
    expect(
      (await persistence.recoverGuestDraft())?.audio_segments[0]?.status,
    ).toBe("finalised");
  });

  it("does not create an empty draft when microphone permission is denied", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    render(
      <App
        dependencies={{
          persistence,
          createRecorder: () => ({
            start: () =>
              Promise.reject(
                new MicrophoneFailure("denied", "Synthetic denial."),
              ),
            stop: vi.fn(),
          }),
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(
      screen.getByRole("button", { name: "Allow and start" }),
    );

    expect(
      await screen.findByRole("dialog", {
        name: "Microphone access is blocked",
      }),
    ).toBeInTheDocument();
    await expect(persistence.recoverGuestDraft()).resolves.toBeNull();
  });

  it("offers an emergency download when recording starts but its local segment cannot be created", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    vi.spyOn(persistence, "createAudioSegment").mockRejectedValueOnce(
      new Error("synthetic-segment-write-failure"),
    );
    const blob = new Blob(["synthetic-early-recording"], {
      type: "audio/webm",
    });

    render(
      <App
        dependencies={{
          persistence,
          createRecorder: () => ({
            start: () => Promise.resolve("audio/webm"),
            stop: () =>
              Promise.resolve({
                blob,
                byteSize: blob.size,
                durationMs: 350,
                mediaType: blob.type,
                chunks: [],
                parts: [
                  {
                    blob,
                    byteSize: blob.size,
                    durationMs: 350,
                    mediaType: blob.type,
                    sequenceNumber: 1,
                    startOffsetMs: 0,
                    chunks: [],
                  },
                ],
                stoppedAtLimit: false,
                persistenceAcknowledged: false,
              }),
          }),
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(
      screen.getByRole("button", { name: "Allow and start" }),
    );

    expect(
      await screen.findByText(/download the recording backup now/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /download recording backup/i }),
    ).toBeEnabled();
    await expect(persistence.recoverGuestDraft()).resolves.toBeNull();
  });

  it("does not start recording or send a sign-in link until the latest typing is saved locally", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    const start = vi.fn().mockResolvedValue("audio/webm");
    vi.spyOn(persistence, "saveText").mockRejectedValue(
      new Error("synthetic-device-save-failure"),
    );

    render(
      <App
        dependencies={{
          persistence,
          createRecorder: () => ({ start, stop: vi.fn() }),
          isCloudConfigured: () => true,
          getCurrentSession: () => Promise.resolve(null),
          onAuthStateChange: () => () => undefined,
          continueWithEmailMagicLink: vi.fn(),
        }}
      />,
    );

    const editor = screen.getByRole("textbox", {
      name: "Write or edit your story",
    });
    await user.type(editor, "X");
    expect(
      await screen.findByText(
        "Your latest changes could not yet be saved on this device. Keep this page open and try typing again.",
      ),
    ).toBeInTheDocument();

    expect(start).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Start recording" }),
    ).toBeDisabled();
    expect(
      await screen.findByText(/cannot safely save a story/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Keep this story" }));
    await user.type(
      screen.getByRole("textbox", { name: "Email address" }),
      "person@example.test",
    );
    await user.click(
      screen.getByRole("button", { name: "Email me a link" }),
    );

    expect(
      await screen.findAllByText(
        "The sign-in link was not sent because your latest typing is not yet secure on this device.",
      ),
    ).not.toHaveLength(0);
    expect(start).not.toHaveBeenCalled();
  });

  it("sends a magic link only after local save and keeps the status device-only", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    const sendMagicLink = vi
      .fn<(email: string, context: AuthReturnContext) => Promise<void>>()
      .mockResolvedValue(undefined);

    render(
      <App
        dependencies={{
          persistence,
          isCloudConfigured: () => true,
          getCurrentSession: () => Promise.resolve(null),
          onAuthStateChange: () => () => undefined,
          continueWithEmailMagicLink: sendMagicLink,
        }}
      />,
    );

    const editor = screen.getByRole("textbox", {
      name: "Write or edit your story",
    });
    await user.type(editor, "A synthetic story kept safely on this device.");
    await screen.findByText("Saved locally");

    await user.click(screen.getByRole("button", { name: "Keep this story" }));
    await user.type(
      screen.getByRole("textbox", { name: "Email address" }),
      "person@example.test",
    );
    await user.click(
      screen.getByRole("button", { name: "Email me a link" }),
    );

    await waitFor(() => expect(sendMagicLink).toHaveBeenCalledOnce());
    const request = sendMagicLink.mock.calls[0];
    expect(request?.[0]).toBe("person@example.test");
    expect(request?.[1]).toMatchObject({
      selectionStart: 45,
      selectionEnd: 45,
    });
    expect(request?.[1].clientStoryId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/,
    );
    expect(await screen.findByText(/check your email/i)).toBeInTheDocument();
    expect(screen.getByText("Saved locally")).toBeInTheDocument();
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("keeps a failed transcript retryable until the user keeps only the audio", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    const start = vi.fn().mockResolvedValue("audio/webm");

    render(
      <App
        dependencies={{
          persistence,
          createRecorder: (options) => ({
            start,
            stop: async () => {
              const blob = new Blob(["synthetic-audio"], {
                type: "audio/webm",
              });
              await options.onChunk({
                blob,
                byteSize: blob.size,
                mediaType: blob.type,
                sequenceNumber: 1,
              });
              return {
                blob,
                byteSize: blob.size,
                durationMs: 900,
                mediaType: blob.type,
                chunks: [],
                stoppedAtLimit: false,
                persistenceAcknowledged: true,
              };
            },
          }),
          transcribe: () =>
            Promise.reject(new Error("Transcription is temporarily unavailable.")),
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(
      screen.getByRole("button", { name: "Allow and start" }),
    );
    await screen.findByRole("button", { name: "Stop recording" });
    await user.click(screen.getByRole("button", { name: "Stop recording" }));

    expect(
      await screen.findByText("Transcription is temporarily unavailable."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Keep audio and continue" }),
    ).toBeEnabled();

    await user.type(
      screen.getByRole("textbox", { name: "Write or edit your story" }),
      "I can safely keep writing.",
    );

    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    const recordingButton = screen.getByRole("button", {
      name: "Transcript needs attention",
    });
    expect(recordingButton).toBeDisabled();
    await user.click(recordingButton);
    expect(start).toHaveBeenCalledOnce();

    await user.click(
      screen.getByRole("button", { name: "Keep audio and continue" }),
    );
    expect(
      await screen.findByText(/original recording is kept without a transcript/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start recording" }),
    ).toBeEnabled();
    expect(
      (await persistence.recoverGuestDraft())?.audio_segments[0]
        ?.transcription_disposition,
    ).toBe("skipped");
  });

  it("does not offer a futile retry for a non-retryable transcript failure", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    render(
      <App
        dependencies={{
          persistence,
          createRecorder: (options) => ({
            start: () => Promise.resolve("audio/webm"),
            stop: async () => {
              const blob = new Blob(["synthetic-invalid-request-audio"], {
                type: "audio/webm",
              });
              await options.onChunk({
                blob,
                byteSize: blob.size,
                mediaType: blob.type,
                sequenceNumber: 1,
              });
              return {
                blob,
                byteSize: blob.size,
                durationMs: 700,
                mediaType: blob.type,
                chunks: [],
                stoppedAtLimit: false,
                persistenceAcknowledged: true,
              };
            },
          }),
          transcribe: () =>
            Promise.reject(
              new TranscriptionError(
                "TRANSCRIPTION_PARTS_INVALID",
                "This recording could not be sent for transcription.",
                false,
              ),
            ),
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(
      screen.getByRole("button", { name: "Allow and start" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Stop recording" }),
    );

    expect(
      await screen.findByText("This recording could not be sent for transcription."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Keep audio and continue" }),
    ).toBeEnabled();
  });

  it("guards rapid transcript retry clicks with one in-flight attempt", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    const retryResult = deferred<TranscriptionResult>();
    const transcribe = vi
      .fn()
      .mockRejectedValueOnce(new Error("Synthetic temporary failure."))
      .mockReturnValueOnce(retryResult.promise);
    render(
      <App
        dependencies={{
          persistence,
          createRecorder: (options) => ({
            start: () => Promise.resolve("audio/webm"),
            stop: async () => {
              const blob = new Blob(["synthetic-rapid-retry-audio"], {
                type: "audio/webm",
              });
              await options.onChunk({
                blob,
                byteSize: blob.size,
                mediaType: blob.type,
                sequenceNumber: 1,
              });
              return {
                blob,
                byteSize: blob.size,
                durationMs: 750,
                mediaType: blob.type,
                chunks: [],
                stoppedAtLimit: false,
                persistenceAcknowledged: true,
              };
            },
          }),
          transcribe,
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(
      screen.getByRole("button", { name: "Allow and start" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Stop recording" }),
    );
    const retry = await screen.findByRole("button", { name: "Try again" });
    fireEvent.click(retry);
    await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(2));
    fireEvent.click(retry);

    expect(transcribe).toHaveBeenCalledTimes(2);
    retryResult.resolve({
      text: "A fictional retry finished once.",
      provider: "synthetic-openai-test",
      model: "synthetic-model",
      language: "en",
      uncertainties: [],
    });
    expect(
      await screen.findByDisplayValue("A fictional retry finished once."),
    ).toBeInTheDocument();
  });

  it("clears an interrupted recording that contains no audio chunks", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    await persistence.createAudioSegment({
      media_type: "audio/webm",
    });

    render(<App dependencies={{ persistence }} />);

    expect(
      await screen.findByText(/An interrupted recording was found/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByText(/No audio was captured in that interrupted attempt/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start recording" }),
    ).toBeEnabled();
    await expect(persistence.recoverGuestDraft()).resolves.toBeNull();
  });

  it("opens recoverable history and restores without destroying later versions", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    const firstText = "On a fictional Tuesday, Lina kept the green ticket.";
    const laterText = "On a fictional Tuesday, Lina gave the green ticket away.";
    await persistence.saveText({ current_text: firstText });
    const earlierVersion = await persistence.appendStoryVersion({
      reason: "meaningful-edit",
    });
    await persistence.saveText({ current_text: laterText });

    render(<App dependencies={{ persistence }} />);

    const editor = await screen.findByRole("textbox", {
      name: "Write or edit your story",
    });
    await waitFor(() => expect(editor).toHaveValue(laterText));
    await user.click(screen.getByText("Originals & history"));
    await user.click(
      screen.getByRole("button", { name: "View version history" }),
    );

    expect(
      await screen.findByRole("dialog", { name: "Version history" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Text of version 1")).toHaveTextContent(
      firstText,
    );
    await user.click(
      screen.getByRole("button", { name: "Restore version 1" }),
    );

    await waitFor(() => expect(editor).toHaveValue(firstText));
    const recovered = await persistence.recoverGuestDraft();
    expect(recovered?.story_versions).toHaveLength(2);
    expect(recovered?.story.current_version_id).not.toBe(
      earlierVersion.value.client_version_id,
    );
    expect(screen.getByText("Saved locally")).toBeInTheDocument();
  });

  it("preserves both cloud-conflict candidates until Version history receives a deliberate choice", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    const baseText = "A fictional harbour keeper logged one amber buoy.";
    const accountText = `${baseText} The account copy noted a blue sail.`;
    const deviceText = `${baseText} This device noted a green sail.`;
    const ownerId = crypto.randomUUID();
    const storyId = crypto.randomUUID();

    const local = await persistence.saveText({ current_text: baseText });
    if (!local) {
      throw new Error("Synthetic test setup did not create a story.");
    }
    const baseVersion = await persistence.ensureCurrentStoryVersion({
      reason: "cloud-sync",
    });
    const migration = await persistence.beginMigration();
    await persistence.markMigration({
      owner_id: ownerId,
      story_id: storyId,
      idempotency_key: migration.value.idempotency_key,
      payload_generation: migration.value.payload_generation,
      cloud_revision: 2,
      cloud_version_id: baseVersion.value.client_version_id,
    });
    await persistence.saveText({ current_text: deviceText });
    const deviceVersion = await persistence.ensureCurrentStoryVersion({
      reason: "cloud-sync",
    });

    const accountVersionId = crypto.randomUUID();
    const incumbentStory: CloudStory = {
      id: storyId,
      owner_id: ownerId,
      client_story_id: local.value.client_story_id,
      title: null,
      current_text: accountText,
      current_version_id: accountVersionId,
      revision: 3,
      captured_at: "2026-07-19T00:00:00.000Z",
      created_at: "2026-07-19T00:00:00.000Z",
      updated_at: "2026-07-19T00:03:00.000Z",
    };
    const conflict = new CloudStoryEditConflictError(
      {
        id: crypto.randomUUID(),
        story_id: storyId,
        owner_id: ownerId,
        expected_revision: 2,
        observed_revision: 3,
        incumbent_version_id: accountVersionId,
        candidate_version_id: deviceVersion.value.client_version_id,
        candidate_title: null,
        title_was_updated: false,
        created_at: "2026-07-19T00:03:00.000Z",
      },
      incumbentStory,
    );
    const cloud = {
      openStory: vi.fn().mockResolvedValue({
        story: incumbentStory,
        audio_segments: [],
        audio_parts: [],
        original_transcripts: [],
        versions: [
          {
            id: accountVersionId,
            story_id: storyId,
            owner_id: ownerId,
            version_number: 3,
            story_text: accountText,
            reason: "cloud-sync",
            restored_from_version_id: null,
            content_sha256: null,
            created_at: "2026-07-19T00:03:00.000Z",
          },
        ],
        edit_conflicts: [conflict.conflict],
      }),
    } as unknown as CloudPersistence;
    const synchronise = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockImplementationOnce(async (localPersistence: GuestPersistence) => {
        const attempt = (await localPersistence.beginCloudSync()).value;
        expect(attempt.last_acknowledged_cloud_revision).toBe(3);
        expect(attempt.last_acknowledged_cloud_version_id).toBe(
          accountVersionId,
        );
        const chosen = await localPersistence.recoverGuestDraft();
        expect(chosen?.story.current_text).toBe(accountText);
        const acknowledged = (
          await localPersistence.acknowledgeCloudSync({
            client_story_id: attempt.client_story_id,
            story_id: attempt.story_id,
            payload_generation: attempt.payload_generation,
            cloud_revision: 4,
            cloud_version_id: chosen?.story.current_version_id ?? null,
          })
        ).value;
        return {
          storyId: attempt.story_id,
          ownerId: attempt.owner_id,
          acknowledgedGeneration: acknowledged.cloud_synced_generation,
          fullySynced: true,
        };
      });

    render(
      <App
        dependencies={{
          persistence,
          createCloudPersistence: () => cloud,
          getCurrentSession: () =>
            Promise.resolve({ user: { id: ownerId } } as Session),
          isCloudConfigured: () => true,
          onAuthStateChange: () => () => undefined,
          synchroniseActiveStory: synchronise,
          takeAuthReturnContext: () => null,
        }}
      />,
    );

    expect(
      await screen.findByText(/Both versions are safe/i),
    ).toBeInTheDocument();
    const editor = screen.getByRole("textbox", {
      name: "Write or edit your story",
    });
    expect(editor).toHaveValue(deviceText);

    await user.type(editor, " A later device note stayed local.");
    await waitFor(() => expect(synchronise).toHaveBeenCalledTimes(1));
    await waitFor(async () => {
      const unresolved = await persistence.recoverGuestDraft();
      expect(unresolved?.story.current_text).toBe(
        `${deviceText} A later device note stayed local.`,
      );
      expect(unresolved?.migration_outbox).toMatchObject({
        state: "pending",
        last_acknowledged_cloud_revision: 2,
      });
    });
    await user.click(
      screen.getByRole("button", { name: "Review versions" }),
    );

    const history = await screen.findByRole("dialog", {
      name: "Version history",
    });
    expect(within(history).getByText("This device’s version")).toBeVisible();
    expect(within(history).getByText("Account-saved version")).toBeVisible();
    const accountCard = within(history)
      .getByText(accountText)
      .closest("article");
    if (!accountCard) {
      throw new Error("The synthetic account candidate card was unavailable.");
    }
    await user.click(
      within(accountCard).getByRole("button", {
        name: /Use account-saved version/,
      }),
    );

    await waitFor(() => expect(editor).toHaveValue(accountText));
    await waitFor(() => expect(synchronise).toHaveBeenCalledTimes(2));
    await waitFor(async () => {
      expect(
        (await persistence.recoverGuestDraft())?.migration_outbox,
      ).toMatchObject({
        state: "completed",
        last_acknowledged_cloud_revision: 4,
      });
    });
    const recovered = await persistence.recoverGuestDraft();
    expect(recovered?.story_versions.map((version) => version.story_text)).toEqual(
      expect.arrayContaining([
        accountText,
        `${deviceText} A later device note stayed local.`,
      ]),
    );
    expect(
      screen.queryByRole("button", { name: "Review versions" }),
    ).not.toBeInTheDocument();
  });

  it("recovers a guest draft and discards it only after explicit confirmation", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    const text = "A fictional glassblower remembered a quiet blue lantern.";
    await persistence.saveText({ current_text: text });
    const discard = vi.spyOn(persistence, "discardGuestDraft");

    render(<App dependencies={{ persistence }} />);

    const editor = await screen.findByDisplayValue(text);
    const discardButton = await screen.findByRole("button", {
      name: "Discard draft",
    });
    await user.click(discardButton);
    expect(
      screen.getByRole("dialog", { name: "Discard this draft?" }),
    ).toBeInTheDocument();
    expect(discard).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Keep draft" }));
    expect(discard).not.toHaveBeenCalled();
    expect(editor).toHaveValue(text);

    await user.click(discardButton);
    await user.click(
      within(
        screen.getByRole("dialog", { name: "Discard this draft?" }),
      ).getByRole("button", { name: "Discard draft" }),
    );
    await waitFor(() => expect(editor).toHaveValue(""));
    expect(discard).toHaveBeenCalledOnce();
    expect(await persistence.recoverGuestDraft()).toBeNull();
  });

  it("keeps and migrates the active guest story on its matching email magic-link return", async () => {
    const persistence = testPersistence();
    const text = "A fictional cartographer kept the name of an amber island.";
    const local = await persistence.saveText({ current_text: text });
    if (!local) {
      throw new Error("Synthetic test setup did not create a story.");
    }
    const ownerId = crypto.randomUUID();
    const storyId = crypto.randomUUID();
    const synchronise = vi.fn(
      async (localPersistence: GuestPersistence) => {
        const active = await localPersistence.recoverGuestDraft();
        if (!active) {
          return null;
        }
        if (!active.migration_receipt) {
          const migration = await localPersistence.beginMigration();
          await localPersistence.markMigration({
            owner_id: ownerId,
            story_id: storyId,
            idempotency_key: migration.value.idempotency_key,
            payload_generation: migration.value.payload_generation,
            cloud_revision: 1,
            cloud_version_id: null,
          });
        }
        return {
          storyId,
          ownerId,
          acknowledgedGeneration:
            (await localPersistence.getMigrationOutbox())
              ?.cloud_synced_generation ?? 0,
          fullySynced: true,
        };
      },
    );

    render(
      <App
        dependencies={{
          persistence,
          createCloudPersistence: () => ({}) as CloudPersistence,
          getCurrentSession: () =>
            Promise.resolve({ user: { id: ownerId } } as Session),
          isCloudConfigured: () => true,
          onAuthStateChange: () => () => undefined,
          synchroniseActiveStory: synchronise,
          takeAuthReturnContext: () => ({
            clientStoryId: local.value.client_story_id,
            selectionStart: text.length,
            selectionEnd: text.length,
          }),
        }}
      />,
    );

    expect(await screen.findByDisplayValue(text)).toBeInTheDocument();
    await waitFor(() => expect(synchronise).toHaveBeenCalled());
    await waitFor(async () => {
      expect(
        (await persistence.recoverGuestDraft())?.migration_receipt,
      ).toMatchObject({ owner_id: ownerId, story_id: storyId });
    });
    expect(
      screen.queryByRole("button", { name: "Discard draft" }),
    ).not.toBeInTheDocument();
  });

  it("opens a fresh canvas on a normal authenticated reload only after clearing an acknowledged local mirror", async () => {
    const persistence = testPersistence();
    const ownerId = crypto.randomUUID();
    const storyId = crypto.randomUUID();
    const clientStoryId = crypto.randomUUID();
    await persistence.adoptCloudStory({
      owner_id: ownerId,
      story_id: storyId,
      client_story_id: clientStoryId,
      title: null,
      current_text: "A fictional account-saved story about a brass compass.",
      cloud_revision: 2,
      cloud_version_id: null,
      captured_at: Date.now(),
    });
    const synchronise = vi.fn().mockResolvedValue({
      storyId,
      ownerId,
      acknowledgedGeneration: 1,
      fullySynced: true,
    });

    render(
      <App
        dependencies={{
          persistence,
          createCloudPersistence: () => ({}) as CloudPersistence,
          getCurrentSession: () =>
            Promise.resolve({ user: { id: ownerId } } as Session),
          isCloudConfigured: () => true,
          onAuthStateChange: () => () => undefined,
          synchroniseActiveStory: synchronise,
          takeAuthReturnContext: () => null,
        }}
      />,
    );

    await waitFor(() => expect(synchronise).toHaveBeenCalledOnce());
    await waitFor(async () => {
      expect(await persistence.recoverGuestDraft()).toBeNull();
    });
    expect(
      screen.getByRole("textbox", { name: "Write or edit your story" }),
    ).toHaveValue("");
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Start a new story" }),
    ).not.toBeInTheDocument();
  });

  it("keeps an unsynced story open and lets the person retry cloud sync", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    const text = "A fictional unsynced story about a lilac observatory.";
    await persistence.saveText({ current_text: text });
    const ownerId = crypto.randomUUID();
    const storyId = crypto.randomUUID();
    const synchronise = vi
      .fn()
      .mockRejectedValue(new Error("synthetic-offline"));

    render(
      <App
        dependencies={{
          persistence,
          createCloudPersistence: () => ({}) as CloudPersistence,
          getCurrentSession: () =>
            Promise.resolve({ user: { id: ownerId } } as Session),
          isCloudConfigured: () => true,
          onAuthStateChange: () => () => undefined,
          synchroniseActiveStory: synchronise,
          takeAuthReturnContext: () => null,
        }}
      />,
    );

    expect(await screen.findByDisplayValue(text)).toBeInTheDocument();
    expect(
      await screen.findByText(/could not be acknowledged by cloud saving/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start a new story" }),
    ).toBeDisabled();
    expect((await persistence.recoverGuestDraft())?.story.current_text).toBe(
      text,
    );

    synchronise.mockResolvedValue({
      storyId,
      ownerId,
      acknowledgedGeneration: 1,
      fullySynced: true,
    });
    await user.click(
      await screen.findByRole("button", { name: "Sync now" }),
    );

    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(screen.getByText("Private in your account")).toBeInTheDocument();
    expect(
      screen.queryByText(/could not be acknowledged by cloud saving/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sync now" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start a new story" }),
    ).toBeEnabled();
  });

  it("queues immediate authenticated typing as a new story while the acknowledged prior mirror is cleared", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    const ownerId = crypto.randomUUID();
    const storyId = crypto.randomUUID();
    const priorClientStoryId = crypto.randomUUID();
    await persistence.adoptCloudStory({
      owner_id: ownerId,
      story_id: storyId,
      client_story_id: priorClientStoryId,
      title: null,
      current_text: "A fictional prior cloud story about a cedar box.",
      cloud_revision: 4,
      cloud_version_id: null,
      captured_at: Date.now(),
    });
    const firstSync = deferred<{
      storyId: string;
      ownerId: string;
      acknowledgedGeneration: number;
      fullySynced: boolean;
    }>();
    const synchronise = vi
      .fn()
      .mockImplementationOnce(() => firstSync.promise)
      .mockRejectedValue(new Error("synthetic-new-story-offline"));

    render(
      <App
        dependencies={{
          persistence,
          createCloudPersistence: () => ({}) as CloudPersistence,
          getCurrentSession: () =>
            Promise.resolve({ user: { id: ownerId } } as Session),
          isCloudConfigured: () => true,
          onAuthStateChange: () => () => undefined,
          synchroniseActiveStory: synchronise,
          takeAuthReturnContext: () => null,
        }}
      />,
    );

    await waitFor(() => expect(synchronise).toHaveBeenCalledOnce());
    const editor = screen.getByRole("textbox", {
      name: "Write or edit your story",
    });
    const newText = "A fictional new story began with a silver feather.";
    await user.type(editor, newText);
    firstSync.resolve({
      storyId,
      ownerId,
      acknowledgedGeneration: 1,
      fullySynced: true,
    });

    await waitFor(async () => {
      const active = await persistence.recoverGuestDraft();
      expect(active?.story.current_text).toBe(newText);
      expect(active?.story.client_story_id).not.toBe(priorClientStoryId);
    });
    expect(editor).toHaveValue(newText);
  });

  it("starts a new authenticated story only after the current one is acknowledged", async () => {
    const user = userEvent.setup();
    const persistence = testPersistence();
    const ownerId = crypto.randomUUID();
    const storyId = crypto.randomUUID();
    const clientStoryId = crypto.randomUUID();
    const text = "A fictional saved story about a clockwork heron.";
    await persistence.adoptCloudStory({
      owner_id: ownerId,
      story_id: storyId,
      client_story_id: clientStoryId,
      title: null,
      current_text: text,
      cloud_revision: 2,
      cloud_version_id: null,
      captured_at: Date.now(),
    });

    render(
      <App
        dependencies={{
          persistence,
          createCloudPersistence: () => ({}) as CloudPersistence,
          getCurrentSession: () =>
            Promise.resolve({ user: { id: ownerId } } as Session),
          isCloudConfigured: () => true,
          onAuthStateChange: () => () => undefined,
          synchroniseActiveStory: vi.fn().mockResolvedValue({
            storyId,
            ownerId,
            acknowledgedGeneration: 1,
            fullySynced: true,
          }),
          takeAuthReturnContext: () => ({
            clientStoryId,
            selectionStart: text.length,
            selectionEnd: text.length,
          }),
        }}
      />,
    );

    const editor = await screen.findByDisplayValue(text);
    const newStory = await screen.findByRole("button", {
      name: "Start a new story",
    });
    await waitFor(() => expect(newStory).toBeEnabled());
    await user.click(newStory);

    await waitFor(() => expect(editor).toHaveValue(""));
    expect(await persistence.recoverGuestDraft()).toBeNull();
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });
});
