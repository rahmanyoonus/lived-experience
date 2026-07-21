import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChunkedAudioRecorder,
  chooseSupportedMediaType,
  classifyMicrophoneFailure,
} from "./recorder";

const originalMediaDevicesDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "mediaDevices",
);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalMediaDevicesDescriptor) {
    Object.defineProperty(
      navigator,
      "mediaDevices",
      originalMediaDevicesDescriptor,
    );
  } else {
    Reflect.deleteProperty(navigator, "mediaDevices");
  }
});

describe("recording capability helpers", () => {
  it("selects the first supported media type", () => {
    const recorder: Pick<typeof MediaRecorder, "isTypeSupported"> = {
      isTypeSupported: (mediaType: string) => mediaType === "audio/mp4",
    };

    expect(chooseSupportedMediaType(recorder)).toBe("audio/mp4");
  });

  it("returns undefined when recording is unavailable", () => {
    expect(chooseSupportedMediaType(undefined)).toBeUndefined();
  });

  it("maps browser microphone errors without exposing their messages", () => {
    expect(
      classifyMicrophoneFailure(new DOMException("synthetic", "NotAllowedError")),
    ).toBe("denied");
    expect(
      classifyMicrophoneFailure(new DOMException("synthetic", "NotFoundError")),
    ).toBe("unavailable");
    expect(classifyMicrophoneFailure(new Error("synthetic"))).toBe("error");
  });

  it.each(["construction", "start"] as const)(
    "stops the acquired microphone track when MediaRecorder %s fails",
    async (failurePoint) => {
      const stopTrack = vi.fn();
      const stream = {
        getTracks: () => [{ stop: stopTrack }],
      } as unknown as MediaStream;
      const getUserMedia = vi.fn().mockResolvedValue(stream);
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia },
      });

      class FailingMediaRecorder extends EventTarget {
        static isTypeSupported(): boolean {
          return true;
        }

        readonly mimeType = "audio/webm";
        readonly state = "inactive";

        constructor() {
          super();
          if (failurePoint === "construction") {
            throw new Error("synthetic-construction-failure");
          }
        }

        start(): void {
          throw new Error("synthetic-start-failure");
        }
      }

      vi.stubGlobal("MediaRecorder", FailingMediaRecorder);

      const recorder = new ChunkedAudioRecorder({
        onChunk: vi.fn(),
      });

      await expect(recorder.start()).rejects.toMatchObject({
        name: "MicrophoneFailure",
        kind: "error",
      });
      expect(getUserMedia).toHaveBeenCalledWith({
        audio: { channelCount: { ideal: 1 } },
      });
      expect(stopTrack).toHaveBeenCalledOnce();
      expect(recorder.isRecording).toBe(false);
    },
  );

  it("rotates completed recorder runs into ordered standalone parts", async () => {
    vi.useFakeTimers();
    const stopTrack = vi.fn();
    const stream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });

    class SyntheticMediaRecorder extends EventTarget {
      static instances: SyntheticMediaRecorder[] = [];
      static isTypeSupported(mediaType: string): boolean {
        return mediaType === "audio/webm;codecs=opus";
      }

      readonly mimeType = "audio/webm;codecs=opus";
      state: RecordingState = "inactive";

      constructor() {
        super();
        SyntheticMediaRecorder.instances.push(this);
      }

      start(): void {
        this.state = "recording";
      }

      stop(): void {
        const partNumber = SyntheticMediaRecorder.instances.indexOf(this) + 1;
        const event = new Event("dataavailable") as BlobEvent;
        Object.defineProperty(event, "data", {
          value: new Blob([`synthetic-part-${partNumber}`], {
            type: this.mimeType,
          }),
        });
        this.dispatchEvent(event);
        this.state = "inactive";
        this.dispatchEvent(new Event("stop"));
      }
    }
    vi.stubGlobal("MediaRecorder", SyntheticMediaRecorder);
    const persistedOrder: string[] = [];
    const recorder = new ChunkedAudioRecorder({
      chunkIntervalMs: 5,
      partRotationMs: 100,
      maxDurationMs: 1_000,
      onChunk: (chunk) => {
        persistedOrder.push(`chunk-${chunk.partSequenceNumber}`);
        return Promise.resolve();
      },
      onPartCompleted: (part) => {
        persistedOrder.push(`part-${part.sequenceNumber}`);
        return Promise.resolve();
      },
    });

    await recorder.start();
    await vi.advanceTimersByTimeAsync(100);
    const completed = await recorder.stop();

    expect(completed.parts).toHaveLength(2);
    expect(completed.parts?.map((part) => part.sequenceNumber)).toEqual([1, 2]);
    expect(completed.parts?.map((part) => part.startOffsetMs)).toEqual([0, 100]);
    expect(completed.durationMs).toBe(101);
    expect(persistedOrder).toEqual([
      "chunk-1",
      "part-1",
      "chunk-2",
      "part-2",
    ]);
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("keeps a delayed browser stop within the logical segment ceiling", async () => {
    vi.useFakeTimers();
    const stream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });

    class SyntheticMediaRecorder extends EventTarget {
      static isTypeSupported(mediaType: string): boolean {
        return mediaType === "audio/webm;codecs=opus";
      }

      readonly mimeType = "audio/webm;codecs=opus";
      state: RecordingState = "inactive";

      start(): void {
        this.state = "recording";
      }

      stop(): void {
        const event = new Event("dataavailable") as BlobEvent;
        Object.defineProperty(event, "data", {
          value: new Blob(["synthetic-delayed-stop"], {
            type: this.mimeType,
          }),
        });
        this.dispatchEvent(event);
        this.state = "inactive";
        this.dispatchEvent(new Event("stop"));
      }
    }
    vi.stubGlobal("MediaRecorder", SyntheticMediaRecorder);

    const recorder = new ChunkedAudioRecorder({
      maxDurationMs: 100,
      partRotationMs: 1_000,
      onChunk: () => Promise.resolve(),
      onDurationLimit: () => {
        setTimeout(() => void recorder.stop(), 25);
      },
    });

    await recorder.start();
    await vi.advanceTimersByTimeAsync(125);
    const completed = await recorder.stop();

    expect(completed.stoppedAtLimit).toBe(true);
    expect(completed.durationMs).toBe(100);
    expect(completed.parts?.[0]?.durationMs).toBe(100);
  });

  it("stops after the first rejected device write and returns the in-memory audio", async () => {
    const stream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });

    class SyntheticMediaRecorder extends EventTarget {
      static instance: SyntheticMediaRecorder | null = null;
      static isTypeSupported(): boolean {
        return true;
      }

      readonly mimeType = "audio/webm";
      state: RecordingState = "inactive";
      stopCalls = 0;

      constructor() {
        super();
        SyntheticMediaRecorder.instance = this;
      }

      start(): void {
        this.state = "recording";
      }

      emit(data: string): void {
        const event = new Event("dataavailable") as BlobEvent;
        Object.defineProperty(event, "data", {
          value: new Blob([data], { type: this.mimeType }),
        });
        this.dispatchEvent(event);
      }

      stop(): void {
        this.stopCalls += 1;
        this.emit("final-in-memory-timeslice");
        this.state = "inactive";
        this.dispatchEvent(new Event("stop"));
      }
    }
    vi.stubGlobal("MediaRecorder", SyntheticMediaRecorder);
    const onPersistenceFailure = vi.fn();
    const recorder = new ChunkedAudioRecorder({
      onChunk: () => Promise.reject(new Error("synthetic-indexeddb-rejection")),
      onPersistenceFailure,
    });

    await recorder.start();
    SyntheticMediaRecorder.instance?.emit("first-in-memory-timeslice");
    await vi.waitFor(() => expect(onPersistenceFailure).toHaveBeenCalledOnce());
    const completed = await recorder.stop();

    expect(SyntheticMediaRecorder.instance?.stopCalls).toBe(1);
    expect(completed.persistenceAcknowledged).toBe(false);
    expect(completed.chunks).toHaveLength(2);
    expect(completed.chunks[0]?.partElapsedMs).toBeGreaterThan(0);
    expect(completed.parts?.[0]?.blob.size).toBeGreaterThan(0);
  });

  it("bounds a browser stop that never emits its completion event", async () => {
    vi.useFakeTimers();
    const stopTrack = vi.fn();
    const stream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });

    class StalledMediaRecorder extends EventTarget {
      static isTypeSupported(): boolean {
        return true;
      }
      readonly mimeType = "audio/webm";
      state: RecordingState = "inactive";
      start(): void {
        this.state = "recording";
      }
      stop(): void {
        // Deliberately never emits stop or error.
      }
    }
    vi.stubGlobal("MediaRecorder", StalledMediaRecorder);
    const recorder = new ChunkedAudioRecorder({
      onChunk: () => Promise.resolve(),
      stopTimeoutMs: 100,
    });

    await recorder.start();
    const stopping = recorder.stop();
    const rejection = expect(stopping).rejects.toThrow(
      "did not finish stopping the recording in time",
    );
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(stopTrack).toHaveBeenCalledOnce();
  });
});
