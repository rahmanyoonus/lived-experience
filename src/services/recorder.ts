export const RECORDING_CHUNK_INTERVAL_MS = 5_000;
export const MAX_SEGMENT_DURATION_MS = 30 * 60 * 1_000;
export const MAX_TRANSCRIPTION_PART_DURATION_MS = 4 * 60 * 1_000;
export const MAX_TRANSCRIPTION_PART_BYTES = 20_000_000;
export const MAX_TRANSCRIPTION_PARTS = 16;
export const TRANSCRIPTION_PART_ROTATION_BYTE_TARGET = 18_000_000;
export const TARGET_AUDIO_BITS_PER_SECOND = 64_000;
export const MEDIA_RECORDER_STOP_TIMEOUT_MS = 10_000;

// Leaving fifteen seconds below the provider ceiling gives delayed browser
// timers a small safety margin while still fitting a 30-minute segment into
// at most eight provider requests.
export const RECORDING_PART_ROTATION_MS = 3 * 60 * 1_000 + 45 * 1_000;

const preferredMediaTypes = [
  "audio/webm;codecs=opus",
  "audio/mp4",
  "audio/webm",
] as const;

export type MicrophoneFailureKind =
  | "denied"
  | "unavailable"
  | "unsupported"
  | "error";

export interface RecordedChunk {
  readonly blob: Blob;
  readonly byteSize: number;
  readonly mediaType: string;
  /** One-based order across the whole explicit start-to-stop segment. */
  readonly sequenceNumber: number;
  /** One-based standalone recording part within the logical segment. */
  readonly partSequenceNumber?: number;
  /** One-based MediaRecorder emission order within this part. */
  readonly partChunkSequenceNumber?: number;
  /** Offset of this standalone part within the logical segment. */
  readonly partStartOffsetMs?: number;
  /** Elapsed time in this recorder run when this timeslice was emitted. */
  readonly partElapsedMs?: number;
}

/**
 * A completed MediaRecorder run. Its Blob is independently playable because
 * it is assembled only from every emission of one stopped recorder instance.
 */
export interface RecordedPart {
  readonly blob: Blob;
  readonly byteSize: number;
  readonly durationMs: number;
  readonly mediaType: string;
  readonly sequenceNumber: number;
  readonly startOffsetMs: number;
  readonly chunks: readonly RecordedChunk[];
}

export interface CompletedRecording {
  /** Compatibility seam for injected single-part recorders in tests. */
  readonly blob?: Blob;
  readonly byteSize: number;
  readonly durationMs: number;
  readonly mediaType: string;
  readonly chunks: readonly RecordedChunk[];
  readonly parts?: readonly RecordedPart[];
  readonly stoppedAtLimit: boolean;
  readonly stoppedAtPartLimit?: boolean;
  /** False when at least one local persistence acknowledgement was rejected. */
  readonly persistenceAcknowledged: boolean;
}

export interface ChunkedRecorderOptions {
  onChunk: (chunk: RecordedChunk) => Promise<void>;
  /** Called only after every chunk for this standalone part is acknowledged. */
  onPartCompleted?: (part: RecordedPart) => Promise<void>;
  onDurationLimit?: () => void;
  onPartLimit?: () => void;
  onPersistenceFailure?: () => void;
  onError?: () => void;
  chunkIntervalMs?: number;
  maxDurationMs?: number;
  partRotationMs?: number;
  stopTimeoutMs?: number;
}

interface ActivePart {
  readonly sequenceNumber: number;
  readonly startOffsetMs: number;
  readonly startedAt: number;
  readonly recorder: MediaRecorder;
  readonly chunks: RecordedChunk[];
  chunkSequenceNumber: number;
}

export class MicrophoneFailure extends Error {
  readonly kind: MicrophoneFailureKind;

  constructor(kind: MicrophoneFailureKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MicrophoneFailure";
    this.kind = kind;
  }
}

export class RecordingPartLimitError extends Error {
  readonly code = "RECORDING_PART_LIMIT_EXCEEDED";

  constructor() {
    super(
      "A standalone recording part exceeded the safe transcription limit. The original audio remains saved on this device.",
    );
    this.name = "RecordingPartLimitError";
  }
}

export function chooseSupportedMediaType(
  mediaRecorder:
    | Pick<typeof MediaRecorder, "isTypeSupported">
    | undefined = globalThis.MediaRecorder,
): string | undefined {
  if (!mediaRecorder) {
    return undefined;
  }

  return preferredMediaTypes.find((mediaType) =>
    mediaRecorder.isTypeSupported(mediaType),
  );
}

export function classifyMicrophoneFailure(error: unknown): MicrophoneFailureKind {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "denied";
    }

    if (
      error.name === "NotFoundError" ||
      error.name === "DevicesNotFoundError" ||
      error.name === "NotReadableError"
    ) {
      return "unavailable";
    }

    if (error.name === "NotSupportedError") {
      return "unsupported";
    }
  }

  return "error";
}

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export class ChunkedAudioRecorder {
  private readonly options: Required<
    Pick<
      ChunkedRecorderOptions,
      | "chunkIntervalMs"
      | "maxDurationMs"
      | "partRotationMs"
      | "stopTimeoutMs"
    >
  > &
    Omit<
      ChunkedRecorderOptions,
      | "chunkIntervalMs"
      | "maxDurationMs"
      | "partRotationMs"
      | "stopTimeoutMs"
    >;

  private activePart: ActivePart | null = null;
  private chunks: RecordedChunk[] = [];
  private completedParts: RecordedPart[] = [];
  private durationLimitTimer: ReturnType<typeof setTimeout> | null = null;
  private mediaStream: MediaStream | null = null;
  private mediaType: string | null = null;
  private partRotationTimer: ReturnType<typeof setTimeout> | null = null;
  private stoppedAtLimit = false;
  private stoppedAtPartLimit = false;
  private partRotationQueued = false;
  private recorderError: unknown = null;
  private stopRequested = false;
  private writeError: unknown = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private transitionQueue: Promise<void> = Promise.resolve();
  private stopPromise: Promise<CompletedRecording> | null = null;

  constructor(options: ChunkedRecorderOptions) {
    this.options = {
      ...options,
      chunkIntervalMs: options.chunkIntervalMs ?? RECORDING_CHUNK_INTERVAL_MS,
      maxDurationMs: options.maxDurationMs ?? MAX_SEGMENT_DURATION_MS,
      partRotationMs: options.partRotationMs ?? RECORDING_PART_ROTATION_MS,
      stopTimeoutMs: options.stopTimeoutMs ?? MEDIA_RECORDER_STOP_TIMEOUT_MS,
    };
  }

  get isRecording(): boolean {
    return !this.stopRequested && this.activePart?.recorder.state === "recording";
  }

  async start(): Promise<string> {
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
      throw new MicrophoneFailure(
        "unsupported",
        "This browser cannot record audio here.",
      );
    }

    if (this.mediaStream || this.activePart) {
      throw new Error("This recorder has already been started.");
    }

    const mediaType = chooseSupportedMediaType();
    if (!mediaType) {
      throw new MicrophoneFailure(
        "unsupported",
        "This browser does not provide a supported recording format.",
      );
    }

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: { ideal: 1 } },
      });
    } catch (error) {
      throw new MicrophoneFailure(
        classifyMicrophoneFailure(error),
        "Microphone access could not be started.",
        { cause: error },
      );
    }

    try {
      this.mediaType = mediaType;
      this.startPart();
      this.durationLimitTimer = setTimeout(() => {
        this.stoppedAtLimit = true;
        this.options.onDurationLimit?.();
      }, this.options.maxDurationMs);
      return mediaType;
    } catch (error) {
      this.clearTimers();
      stopTracks(this.mediaStream);
      this.mediaStream = null;
      this.activePart = null;
      throw new MicrophoneFailure(
        classifyMicrophoneFailure(error),
        "Microphone recording could not be started.",
        { cause: error },
      );
    }
  }

  stop(): Promise<CompletedRecording> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    if (!this.activePart && !this.mediaStream) {
      return Promise.reject(new Error("No recording is active."));
    }

    this.stopRequested = true;
    this.clearTimers();
    this.stopPromise = this.finishStopping();
    return this.stopPromise;
  }

  private startPart(): void {
    const stream = this.mediaStream;
    const mediaType = this.mediaType;
    if (!stream || !mediaType || this.stopRequested) {
      return;
    }

    const startOffsetMs = this.completedParts.reduce(
      (total, completed) => total + completed.durationMs,
      0,
    );
    if (startOffsetMs >= this.options.maxDurationMs) {
      this.stoppedAtLimit = true;
      queueMicrotask(() => this.options.onDurationLimit?.());
      return;
    }

    const recorder = new MediaRecorder(stream, {
      mimeType: mediaType,
      audioBitsPerSecond: TARGET_AUDIO_BITS_PER_SECOND,
    });
    const part: ActivePart = {
      sequenceNumber: this.completedParts.length + 1,
      startOffsetMs,
      startedAt: performance.now(),
      recorder,
      chunks: [],
      chunkSequenceNumber: 0,
    };
    this.activePart = part;

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size === 0) {
        return;
      }
      part.chunkSequenceNumber += 1;
      const chunk: RecordedChunk = {
        blob: event.data,
        byteSize: event.data.size,
        mediaType: event.data.type || mediaType,
        sequenceNumber: this.chunks.length + 1,
        partSequenceNumber: part.sequenceNumber,
        partChunkSequenceNumber: part.chunkSequenceNumber,
        partStartOffsetMs: part.startOffsetMs,
        partElapsedMs: Math.max(
          1,
          Math.round(performance.now() - part.startedAt),
        ),
      };
      part.chunks.push(chunk);
      this.chunks.push(chunk);
      this.writeQueue = this.writeQueue
        .then(() => {
          if (this.writeError) {
            return;
          }
          return this.options.onChunk(chunk);
        })
        .catch((error: unknown) => {
          this.handlePersistenceFailure(error);
        });
      const accumulatedBytes = part.chunks.reduce(
        (total, recorded) => total + recorded.byteSize,
        0,
      );
      if (
        accumulatedBytes >= TRANSCRIPTION_PART_ROTATION_BYTE_TARGET &&
        this.activePart === part
      ) {
        this.queuePartRotation();
      }
    });

    recorder.addEventListener("error", () => {
      this.recorderError ??= new Error(
        "The browser stopped recording unexpectedly.",
      );
      this.clearTimers();
      this.options.onError?.();
    });

    recorder.start(this.options.chunkIntervalMs);
    this.partRotationTimer = setTimeout(() => {
      this.queuePartRotation();
    }, this.options.partRotationMs);
  }

  private queuePartRotation(): void {
    if (this.stopRequested || this.partRotationQueued) {
      return;
    }
    if (this.partRotationTimer) {
      clearTimeout(this.partRotationTimer);
      this.partRotationTimer = null;
    }
    this.partRotationQueued = true;
    this.transitionQueue = this.transitionQueue
      .then(async () => {
        if (this.stopRequested) {
          return;
        }
        await this.completeActivePart(true);
      })
      .catch((error: unknown) => {
        this.clearTimers();
        if (error instanceof RecordingPartLimitError) {
          this.stoppedAtPartLimit = true;
          this.options.onPartLimit?.();
        } else {
          this.recorderError ??= error;
          this.options.onError?.();
        }
      })
      .finally(() => {
        this.partRotationQueued = false;
      });
  }

  private async completeActivePart(restartAfterStop = false): Promise<void> {
    const part = this.activePart;
    if (!part) {
      return;
    }
    if (part.recorder.state === "inactive") {
      throw new Error("The browser stopped recording unexpectedly.");
    }

    const stoppedAt = performance.now();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (result: "stopped" | "error" | "timeout") => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        part.recorder.removeEventListener("stop", handleStop);
        part.recorder.removeEventListener("error", handleError);
        if (result === "stopped") {
          resolve();
        } else {
          reject(
            new Error(
              result === "timeout"
                ? "The browser did not finish stopping the recording in time."
                : "The browser stopped recording unexpectedly.",
            ),
          );
        }
      };
      const handleStop = () => finish("stopped");
      const handleError = () => finish("error");
      const timeout = setTimeout(
        () => finish("timeout"),
        this.options.stopTimeoutMs,
      );
      part.recorder.addEventListener("stop", handleStop, { once: true });
      part.recorder.addEventListener("error", handleError, { once: true });
      try {
        part.recorder.stop();
      } catch {
        finish("error");
      }
    });
    if (part.chunks.length === 0) {
      throw new Error("The browser returned an empty recording.");
    }
    const partMediaType = part.recorder.mimeType || part.chunks[0]?.mediaType;
    if (!partMediaType) {
      throw new Error("The recording format could not be identified.");
    }
    const blob = new Blob(
      part.chunks.map((chunk) => chunk.blob),
      { type: partMediaType },
    );
    // Browser timers may run late, especially after a mobile tab is
    // backgrounded. Keep persisted part metadata internally consistent with
    // the explicit logical-segment ceiling even if the final container holds
    // a small amount of trailing timer jitter.
    const remainingSegmentDurationMs =
      this.options.maxDurationMs - part.startOffsetMs;
    const durationMs = Math.max(
      1,
      Math.min(
        Math.round(stoppedAt - part.startedAt),
        remainingSegmentDurationMs,
      ),
    );
    const completed: RecordedPart = {
      blob,
      byteSize: blob.size,
      durationMs,
      mediaType: partMediaType,
      sequenceNumber: part.sequenceNumber,
      startOffsetMs: part.startOffsetMs,
      chunks: [...part.chunks],
    };

    this.completedParts.push(completed);
    if (this.activePart === part) {
      this.activePart = null;
    }

    // Serialize the completion marker behind every durable timeslice and ahead
    // of any chunks from the next recorder instance.
    if (this.options.onPartCompleted) {
      this.writeQueue = this.writeQueue
        .then(() => {
          if (this.writeError) {
            return;
          }
          return this.options.onPartCompleted!(completed);
        })
        .catch((error: unknown) => {
          this.handlePersistenceFailure(error);
        });
    }

    if (
      completed.durationMs > MAX_TRANSCRIPTION_PART_DURATION_MS ||
      completed.byteSize > MAX_TRANSCRIPTION_PART_BYTES ||
      this.completedParts.length > MAX_TRANSCRIPTION_PARTS
    ) {
      await this.writeQueue;
      throw new RecordingPartLimitError();
    }
    if (restartAfterStop && !this.stopRequested) {
      if (this.completedParts.length >= MAX_TRANSCRIPTION_PARTS) {
        await this.writeQueue;
        this.stoppedAtPartLimit = true;
        this.options.onPartLimit?.();
        return;
      }
      // Restart before IndexedDB acknowledgement to minimise the container
      // boundary gap; writeQueue still preserves durable ordering.
      this.startPart();
    }
    await this.writeQueue;
  }

  private async finishStopping(): Promise<CompletedRecording> {
    try {
      await this.transitionQueue;
      if (this.activePart) {
        try {
          await this.completeActivePart();
        } catch (error) {
          if (error instanceof RecordingPartLimitError) {
            this.stoppedAtPartLimit = true;
          } else {
            throw error;
          }
        }
      }
      await this.writeQueue;
      if (this.completedParts.length === 0) {
        throw new Error("The browser returned an empty recording.");
      }
      const durationMs = this.completedParts.reduce(
        (total, part) => total + part.durationMs,
        0,
      );
      const byteSize = this.completedParts.reduce(
        (total, part) => total + part.byteSize,
        0,
      );
      return {
        byteSize,
        durationMs,
        mediaType: this.mediaType ?? this.completedParts[0]!.mediaType,
        chunks: [...this.chunks],
        parts: [...this.completedParts],
        stoppedAtLimit: this.stoppedAtLimit,
        stoppedAtPartLimit: this.stoppedAtPartLimit,
        persistenceAcknowledged: this.writeError === null,
      };
    } finally {
      stopTracks(this.mediaStream);
      this.mediaStream = null;
      this.activePart = null;
    }
  }

  private clearTimers(): void {
    if (this.durationLimitTimer) {
      clearTimeout(this.durationLimitTimer);
      this.durationLimitTimer = null;
    }
    if (this.partRotationTimer) {
      clearTimeout(this.partRotationTimer);
      this.partRotationTimer = null;
    }
  }

  private handlePersistenceFailure(error: unknown): void {
    if (this.writeError) {
      return;
    }
    this.writeError = error;
    this.clearTimers();
    queueMicrotask(() => {
      this.options.onPersistenceFailure?.();
      void this.stop().catch(() => undefined);
    });
  }
}
