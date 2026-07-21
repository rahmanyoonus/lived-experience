import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Session } from "@supabase/supabase-js";

import { insertTranscript, mapTextPosition } from "./app/textInsertion";
import {
  CaptureCanvas,
  StoryArtefactsDialog,
  StoryLibraryDialog,
  type CapturePhase,
  type CaptureReadinessNotice,
  type EditorSelection,
  type GuidancePromptState,
  type MicrophoneDialogKind,
  type MagicLinkRequestResult,
  type PersistenceState,
  type StoryArtefactsMode,
  type StoryAudioArtefact,
  type StoryLibraryItem,
  type StoryTranscriptArtefact,
  type StoryTranscriptUncertainty,
  type StoryVersionArtefact,
} from "./components";

type StorySurface = "library" | "visualisation" | null;

const StoryVisualisation = lazy(() =>
  import("./components/StoryVisualisation").then((module) => ({
    default: module.StoryVisualisation,
  })),
);
import {
  createGuestPersistence,
  type AudioSegmentRecord,
  type GuestPersistence,
  type RecoveredGuestDraft,
  type StandaloneAudioPart,
  type TranscriptUncertainty,
  type Uuid,
} from "./data";
import { isSupabaseConfigured } from "./lib/supabase";
import {
  completeEmailMagicLinkReturn,
  continueWithEmailMagicLink,
  getCurrentSession,
  onAuthStateChange,
  takeAuthReturnContext,
  type AuthReturnContext,
} from "./services/auth";
import {
  CloudPersistenceError,
  CloudStoryEditConflictError,
  createCloudPersistence as createSupabaseCloudPersistence,
  type CloudPersistence,
  type CloudOpenedStory,
} from "./services/cloudPersistence";
import {
  generateStoryPrompt,
  type PromptGenerationRequest,
  type PromptGenerationResult,
} from "./services/promptGeneration";
import {
  ChunkedAudioRecorder,
  type ChunkedRecorderOptions,
  type CompletedRecording,
  type MicrophoneFailureKind,
  type RecordedPart,
} from "./services/recorder";
import {
  checkCloudReadiness,
  checkDeviceReadiness,
  checkTranscriptionReadiness,
  type CloudReadiness,
  type DeviceReadiness,
  type TranscriptionReadiness,
} from "./services/readiness";
import {
  clearPartialTranscriptionCache,
  transcribeRecording,
  TranscriptionError,
  type TranscriptionAudioPart,
  type TranscriptionRequest,
  type TranscriptionResult,
} from "./services/transcription";
import {
  synchroniseActiveStory as synchroniseActiveStoryWithCloud,
} from "./services/storySync";

interface Recorder {
  start(): Promise<string>;
  stop(): Promise<CompletedRecording>;
}

export interface AppDependencies {
  readonly persistence?: GuestPersistence;
  readonly createRecorder?: (options: ChunkedRecorderOptions) => Recorder;
  readonly transcribe?: (
    request: TranscriptionRequest,
  ) => Promise<TranscriptionResult>;
  readonly generatePrompt?: (
    request: PromptGenerationRequest,
  ) => Promise<PromptGenerationResult>;
  readonly isCloudConfigured?: () => boolean;
  readonly getCurrentSession?: typeof getCurrentSession;
  readonly onAuthStateChange?: typeof onAuthStateChange;
  readonly continueWithEmailMagicLink?: typeof continueWithEmailMagicLink;
  readonly completeEmailMagicLinkReturn?: typeof completeEmailMagicLinkReturn;
  readonly takeAuthReturnContext?: typeof takeAuthReturnContext;
  readonly createCloudPersistence?: () => CloudPersistence;
  readonly synchroniseActiveStory?: typeof synchroniseActiveStoryWithCloud;
  readonly checkDeviceReadiness?: typeof checkDeviceReadiness;
  readonly checkCloudReadiness?: typeof checkCloudReadiness;
  readonly checkTranscriptionReadiness?: typeof checkTranscriptionReadiness;
}

export interface AppProps {
  readonly dependencies?: AppDependencies;
}

interface TranscriptInsertionAnchor {
  position: number;
  previousText: string;
}

interface PendingSegment {
  readonly clientSegmentId: Uuid;
  readonly durationMs: number;
  readonly mediaType: string;
  readonly status: AudioSegmentRecord["status"];
}

interface EmergencyAudioBackup {
  readonly blobs: readonly Blob[];
}

interface ArtefactVersionSource {
  readonly localVersionId: Uuid | null;
  readonly cloudVersionId: Uuid | null;
  readonly text: string;
}

interface ArtefactAudioPartSource {
  readonly src: string;
  readonly startOffsetMs: number;
  readonly durationMs: number;
}

interface DeferredSignal {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function createDeferredSignal(): DeferredSignal {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function phaseForContent(content: string): CapturePhase {
  return content.length > 0 ? "editing" : "empty";
}

function microphoneDialogFor(
  failure: MicrophoneFailureKind,
): MicrophoneDialogKind {
  if (failure === "denied") {
    return "denied";
  }
  if (failure === "unavailable" || failure === "unsupported") {
    return "unavailable";
  }
  return "error";
}

function contentFreeFailureCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]+$/.test(error.code)
  ) {
    return error.code.toLowerCase().replaceAll("_", "-").slice(0, 64);
  }
  return "operation-failed";
}

function cloudSyncFailureMessage(error: unknown): string {
  if (error instanceof CloudPersistenceError) {
    if (error.code.startsWith("AUDIO_")) {
      return "Your story text is safe, but the original recording has not reached your account yet. It remains on this device; try syncing again.";
    }
    if (error.code.startsWith("TRANSCRIPT_")) {
      return "Your recording is safe, but its original transcript has not reached your account yet. It remains on this device; try syncing again.";
    }
    if (
      error.code === "AUTH_REQUIRED" ||
      error.code === "AUTH_CHECK_FAILED"
    ) {
      return "Your sign-in needs refreshing before this story can sync. The latest copy remains saved on this device.";
    }
  }
  return "Your story could not be acknowledged by cloud saving yet. The latest copy remains saved on this device; try syncing again.";
}

function uncertaintyRecords(
  uncertainties: TranscriptionResult["uncertainties"],
): readonly TranscriptUncertainty[] {
  return uncertainties.map((uncertainty) => ({
    start: uncertainty.start,
    end: uncertainty.end,
    audioStartMs: uncertainty.audioStartMs,
    audioEndMs: uncertainty.audioEndMs,
    ...(uncertainty.confidence === undefined
      ? {}
      : { confidence: uncertainty.confidence }),
  }));
}

function transcriptionParts(
  recording: CompletedRecording,
): readonly TranscriptionAudioPart[] {
  const parts = recording.parts;
  if (!parts || parts.length === 0) {
    if (!recording.blob) {
      throw new Error("The completed recording has no standalone audio parts.");
    }
    return [
      {
        audio: recording.blob,
        durationMs: recording.durationMs,
        startOffsetMs: 0,
      },
    ];
  }
  return parts.map((part: RecordedPart) => ({
    audio: part.blob,
    durationMs: part.durationMs,
    startOffsetMs: part.startOffsetMs,
  }));
}

async function recoverMissingRecordingWrites(
  persistence: GuestPersistence,
  clientSegmentId: Uuid,
  recording: CompletedRecording,
): Promise<void> {
  const persisted = await persistence.readAudioChunks(clientSegmentId);
  const persistedSequences = new Set(
    persisted.map((chunk) => chunk.chunk_sequence_number),
  );
  const highestPersisted = persisted.at(-1)?.chunk_sequence_number ?? 0;
  for (let sequence = 1; sequence <= highestPersisted; sequence += 1) {
    if (!persistedSequences.has(sequence)) {
      throw new Error("Saved audio chunks are not an ordered prefix.");
    }
  }

  for (const chunk of recording.chunks) {
    if (persistedSequences.has(chunk.sequenceNumber)) {
      continue;
    }
    if (chunk.sequenceNumber !== persistedSequences.size + 1) {
      throw new Error("Missing audio chunks could not be recovered in order.");
    }
    await persistence.appendAudioChunk({
      client_segment_id: clientSegmentId,
      chunk_sequence_number: chunk.sequenceNumber,
      part_sequence_number: chunk.partSequenceNumber ?? 1,
      part_chunk_sequence_number:
        chunk.partChunkSequenceNumber ?? chunk.sequenceNumber,
      part_start_offset_ms: chunk.partStartOffsetMs ?? 0,
      part_elapsed_ms: chunk.partElapsedMs ?? 1,
      blob: chunk.blob,
    });
    persistedSequences.add(chunk.sequenceNumber);
  }

  for (const part of recording.parts ?? []) {
    await persistence.finaliseAudioPart({
      client_segment_id: clientSegmentId,
      part_sequence_number: part.sequenceNumber,
      duration_ms: part.durationMs,
    });
  }
}

function emergencyBackupFor(
  recording: CompletedRecording,
): EmergencyAudioBackup | null {
  const blobs = (recording.parts ?? [])
    .map((part) => part.blob)
    .filter((blob) => blob.size > 0);
  if (blobs.length > 0) {
    return { blobs };
  }
  return recording.blob && recording.blob.size > 0
    ? { blobs: [recording.blob] }
    : null;
}

function transcriptUncertaintyForDisplay(
  uncertainty: TranscriptUncertainty,
): StoryTranscriptUncertainty | null {
  const start = uncertainty.start;
  const end = uncertainty.end;
  const audioStartMs = uncertainty.audioStartMs;
  const audioEndMs = uncertainty.audioEndMs;
  const confidence = uncertainty.confidence;

  if (
    typeof start !== "number" ||
    !Number.isInteger(start) ||
    start < 0 ||
    typeof end !== "number" ||
    !Number.isInteger(end) ||
    end <= start ||
    typeof audioStartMs !== "number" ||
    !Number.isFinite(audioStartMs) ||
    audioStartMs < 0 ||
    typeof audioEndMs !== "number" ||
    !Number.isFinite(audioEndMs) ||
    audioEndMs <= audioStartMs ||
    (confidence !== undefined &&
      (typeof confidence !== "number" ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1))
  ) {
    return null;
  }

  return {
    start,
    end,
    audioStartMs,
    audioEndMs,
    ...(typeof confidence === "number" ? { confidence } : {}),
  };
}

function isoFromTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function pendingSegmentFrom(
  recovered: RecoveredGuestDraft,
): PendingSegment | null {
  const transcribedIds = new Set(
    recovered.original_transcripts.map(
      (transcript) => transcript.client_segment_id,
    ),
  );
  const segment = [...recovered.audio_segments]
    .reverse()
    .find(
      (candidate) =>
        candidate.status !== "failed" &&
        candidate.transcription_disposition === "pending" &&
        !transcribedIds.has(candidate.client_segment_id),
    );

  return segment
    ? {
        clientSegmentId: segment.client_segment_id,
        durationMs: segment.duration_ms,
        mediaType: segment.media_type,
        status: segment.status,
      }
    : null;
}

export function App({ dependencies = {} }: AppProps) {
  const [ownsPersistence] = useState(
    () => dependencies.persistence === undefined,
  );
  const [persistence] = useState(
    () => dependencies.persistence ?? createGuestPersistence(),
  );
  const [hydrationGate] = useState(createDeferredSignal);
  const cloudConfigured =
    dependencies.isCloudConfigured?.() ?? isSupabaseConfigured();
  const readCurrentSession =
    dependencies.getCurrentSession ?? getCurrentSession;
  const completeMagicLinkReturn =
    dependencies.completeEmailMagicLinkReturn ?? completeEmailMagicLinkReturn;
  const subscribeToAuth =
    dependencies.onAuthStateChange ?? onAuthStateChange;
  const startEmailContinuation =
    dependencies.continueWithEmailMagicLink ?? continueWithEmailMagicLink;
  const readAuthReturnContext =
    dependencies.takeAuthReturnContext ?? takeAuthReturnContext;
  const createCloudPersistence =
    dependencies.createCloudPersistence ?? createSupabaseCloudPersistence;
  const synchroniseActiveStory =
    dependencies.synchroniseActiveStory ?? synchroniseActiveStoryWithCloud;
  const probeDeviceReadiness =
    dependencies.checkDeviceReadiness ?? checkDeviceReadiness;
  const probeCloudReadiness =
    dependencies.checkCloudReadiness ?? checkCloudReadiness;
  const probeTranscriptionReadiness =
    dependencies.checkTranscriptionReadiness ?? checkTranscriptionReadiness;
  const createRecorder = useMemo(
    () =>
      dependencies.createRecorder ??
      ((options: ChunkedRecorderOptions) =>
        new ChunkedAudioRecorder(options)),
    [dependencies.createRecorder],
  );
  const transcribe = useMemo(
    () => dependencies.transcribe ?? transcribeRecording,
    [dependencies.transcribe],
  );
  const generatePrompt = useMemo(
    () => dependencies.generatePrompt ?? generateStoryPrompt,
    [dependencies.generatePrompt],
  );

  const [content, setContent] = useState("");
  const [phase, setPhase] = useState<CapturePhase>("empty");
  const [persistenceState, setPersistenceState] =
    useState<PersistenceState>("idle");
  const [hasStarted, setHasStarted] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [localRecoveryResolved, setLocalRecoveryResolved] = useState(false);
  const [initialSessionResolved, setInitialSessionResolved] = useState(
    !cloudConfigured,
  );
  const [session, setSession] = useState<Session | null>(null);
  const [recordingDurationSeconds, setRecordingDurationSeconds] = useState(0);
  const [captureMessage, setCaptureMessage] = useState<string | null>(null);
  const [guidancePromptState, setGuidancePromptState] =
    useState<GuidancePromptState>({ status: "idle" });
  const [deviceReadiness, setDeviceReadiness] =
    useState<DeviceReadiness | null>(null);
  const [cloudReadiness, setCloudReadiness] =
    useState<CloudReadiness | null>(null);
  const [transcriptionReadiness, setTranscriptionReadiness] =
    useState<TranscriptionReadiness | null>(null);
  const [microphoneDialog, setMicrophoneDialog] =
    useState<MicrophoneDialogKind | null>(null);
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [discardDraftDialogOpen, setDiscardDraftDialogOpen] = useState(false);
  const [isRecoveredGuestDraft, setIsRecoveredGuestDraft] = useState(false);
  const [hasOriginalAudio, setHasOriginalAudio] = useState(false);
  const [hasOriginalTranscript, setHasOriginalTranscript] = useState(false);
  const [hasVersionHistory, setHasVersionHistory] = useState(false);
  const [hasPendingSegment, setHasPendingSegment] = useState(false);
  const [pendingTranscriptRetryable, setPendingTranscriptRetryable] =
    useState(false);
  const [canKeepPendingAudio, setCanKeepPendingAudio] = useState(false);
  const [hasEmergencyAudioBackup, setHasEmergencyAudioBackup] =
    useState(false);
  const [storySurface, setStorySurface] = useState<StorySurface>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryItems, setLibraryItems] = useState<readonly StoryLibraryItem[]>(
    [],
  );
  const [artefactsMode, setArtefactsMode] =
    useState<StoryArtefactsMode | null>(null);
  const [artefactAudioItems, setArtefactAudioItems] = useState<
    readonly StoryAudioArtefact[]
  >([]);
  const [artefactTranscriptItems, setArtefactTranscriptItems] = useState<
    readonly StoryTranscriptArtefact[]
  >([]);
  const [artefactVersionItems, setArtefactVersionItems] = useState<
    readonly StoryVersionArtefact[]
  >([]);
  const [storyEditConflict, setStoryEditConflict] =
    useState<CloudStoryEditConflictError | null>(null);

  const contentRef = useRef(content);
  const restoreVisualisationFocusRef = useRef(false);
  const lastGuidancePromptRef = useRef<string | null>(null);
  const guidancePromptAbortRef = useRef<AbortController | null>(null);
  const guidancePromptRequestRef = useRef(0);
  const currentStoryIdRef = useRef<Uuid | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const activeSegmentIdRef = useRef<Uuid | null>(null);
  const pendingSegmentRef = useRef<PendingSegment | null>(null);
  const recordingStartedAtRef = useRef(0);
  const stopPromiseRef = useRef<Promise<void> | null>(null);
  const retryPromiseRef = useRef<Promise<void> | null>(null);
  const emergencyAudioBackupRef = useRef<EmergencyAudioBackup | null>(null);
  const insertionAnchorRef = useRef<TranscriptInsertionAnchor | null>(null);
  const editorSelectionRef = useRef<EditorSelection>({
    start: 0,
    end: 0,
    direction: "none",
  });
  const deliberateSelectionRef = useRef(false);
  const textGenerationRef = useRef(0);
  const localSaveFailureGenerationRef = useRef<number | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const transcriptApplicationInFlightRef = useRef(false);
  const cloudSyncPromiseRef = useRef<Promise<void> | null>(null);
  const cloudSyncRequestedRef = useRef(false);
  const storyEditConflictRef = useRef<CloudStoryEditConflictError | null>(
    null,
  );
  const recoveredTextBeforeHydrationRef = useRef<string | null>(null);
  const recoveredDraftAtBootstrapRef = useRef<
    RecoveredGuestDraft | null | undefined
  >(undefined);
  const interruptedRecoveryMessageRef = useRef<string | null>(null);
  const localRecoveryFailedRef = useRef(false);
  const bootstrapFinalisedRef = useRef(false);
  const bootstrapSyncInProgressRef = useRef(false);
  const authReturnContextRef = useRef<AuthReturnContext | null | undefined>(
    undefined,
  );
  const artefactObjectUrlsRef = useRef(new Set<string>());
  const artefactAudioSourcesRef = useRef(
    new Map<string, readonly ArtefactAudioPartSource[]>(),
  );
  const artefactVersionSourcesRef = useRef(
    new Map<string, ArtefactVersionSource>(),
  );
  const uncertaintyPlayerRef = useRef<HTMLAudioElement | null>(null);

  const updateGuidancePromptState = useCallback(
    (next: GuidancePromptState) => {
      setGuidancePromptState(next);
    },
    [],
  );

  const cancelGuidancePrompt = useCallback(
    (forgetPrevious = false) => {
      guidancePromptRequestRef.current += 1;
      guidancePromptAbortRef.current?.abort();
      guidancePromptAbortRef.current = null;
      if (forgetPrevious) {
        lastGuidancePromptRef.current = null;
      }
      updateGuidancePromptState({ status: "idle" });
    },
    [updateGuidancePromptState],
  );

  const clearArtefactMedia = useCallback(() => {
    uncertaintyPlayerRef.current?.pause();
    uncertaintyPlayerRef.current = null;
    for (const objectUrl of artefactObjectUrlsRef.current) {
      URL.revokeObjectURL(objectUrl);
    }
    artefactObjectUrlsRef.current.clear();
    artefactAudioSourcesRef.current.clear();
    artefactVersionSourcesRef.current.clear();
  }, []);

  const resetForFreshCanvas = useCallback(
    (preserveInMemoryContent = false) => {
      cancelGuidancePrompt(true);
      clearArtefactMedia();
      const nextContent = preserveInMemoryContent ? contentRef.current : "";
      if (!preserveInMemoryContent) {
        textGenerationRef.current += 1;
        contentRef.current = "";
        setContent("");
      }
      localSaveFailureGenerationRef.current = null;
      recoveredTextBeforeHydrationRef.current = null;
      currentStoryIdRef.current = null;
      recorderRef.current = null;
      activeSegmentIdRef.current = null;
      pendingSegmentRef.current = null;
      insertionAnchorRef.current = null;
      deliberateSelectionRef.current = false;
      editorSelectionRef.current = {
        start: nextContent.length,
        end: nextContent.length,
        direction: "none",
      };
      emergencyAudioBackupRef.current = null;
      storyEditConflictRef.current = null;
      setStoryEditConflict(null);
      setHasStarted(nextContent.length > 0);
      setHasOriginalAudio(false);
      setHasOriginalTranscript(false);
      setHasVersionHistory(false);
      setHasPendingSegment(false);
      setPendingTranscriptRetryable(false);
      setCanKeepPendingAudio(false);
      setHasEmergencyAudioBackup(false);
      setRecordingDurationSeconds(0);
      setPhase(phaseForContent(nextContent));
      setPersistenceState(nextContent.length > 0 ? "saving" : "idle");
      setCaptureMessage(null);
      setMicrophoneDialog(null);
      setEmailDialogOpen(false);
      setDiscardDraftDialogOpen(false);
      setIsRecoveredGuestDraft(false);
      setStorySurface(null);
      setArtefactsMode(null);
    },
    [cancelGuidancePrompt, clearArtefactMedia],
  );

  const setRecoveredDraft = useCallback((recovered: RecoveredGuestDraft) => {
    contentRef.current = recovered.story.current_text;
    setContent(recovered.story.current_text);
    currentStoryIdRef.current = recovered.story.client_story_id;
    setHasStarted(true);
    setHasOriginalAudio(recovered.audio_segments.some((segment) => segment.byte_size > 0));
    setHasOriginalTranscript(recovered.original_transcripts.length > 0);
    setHasVersionHistory(recovered.story_versions.length > 0);

    const pending = pendingSegmentFrom(recovered);
    pendingSegmentRef.current = pending;
    setHasPendingSegment(pending !== null);
    setPendingTranscriptRetryable(pending !== null);
    setCanKeepPendingAudio(pending?.status === "finalised");
    if (pending) {
      setPhase("error");
      setCaptureMessage(
        pending.status === "recording"
          ? "An interrupted recording was found on this device. We’ll preserve every usable part before preparing a transcript."
          : "A saved recording is still waiting for its transcript.",
      );
    } else {
      setPhase(phaseForContent(recovered.story.current_text));
    }

    if (recovered.migration_receipt) {
      setPersistenceState(
        recovered.has_local_changes_after_migration
          ? "not-yet-synced"
          : "saved",
      );
    } else {
      setPersistenceState("saved-locally");
    }
  }, []);

  useEffect(() => () => clearArtefactMedia(), [clearArtefactMedia]);
  useEffect(
    () => () => guidancePromptAbortRef.current?.abort(),
    [],
  );

  useEffect(() => {
    if (storySurface !== null || !restoreVisualisationFocusRef.current) {
      return;
    }
    restoreVisualisationFocusRef.current = false;
    document
      .querySelector<HTMLButtonElement>("[data-visualise-stories-trigger]")
      ?.focus();
  }, [storySurface]);

  useEffect(() => {
    let cancelled = false;
    void probeDeviceReadiness(persistence).then((result) => {
      if (!cancelled) {
        setDeviceReadiness(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [persistence, probeDeviceReadiness]);

  useEffect(() => {
    let cancelled = false;
    void probeTranscriptionReadiness().then((result) => {
      if (!cancelled) {
        setTranscriptionReadiness(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [probeTranscriptionReadiness]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      await persistence.purgeExpiredGuestDrafts();
      let recovered = await persistence.recoverGuestDraft();
      if (cancelled) {
        return;
      }
      let interruptedRecoveryMessage: string | null = null;
      const interrupted = recovered ? pendingSegmentFrom(recovered) : null;
      if (interrupted?.status === "recording") {
        try {
          const outcome = (
            await persistence.recoverInterruptedAudioSegment(
              interrupted.clientSegmentId,
            )
          ).value;
          if (outcome.segment) {
            recovered = await persistence.recoverGuestDraft();
            interruptedRecoveryMessage = outcome.unfinished_tail_preserved
              ? "The completed part of an interrupted recording is available. An unfinished tail remains on this device and may not play."
              : "A best-effort copy of an interrupted recording is available. Playback may depend on what the browser finished before the interruption.";
          }
        } catch {
          interruptedRecoveryMessage =
            "An interrupted recording remains on this device, but this browser could not verify a playable copy yet.";
        }
      }
      recoveredDraftAtBootstrapRef.current = recovered;
      interruptedRecoveryMessageRef.current = interruptedRecoveryMessage;
      setLocalRecoveryResolved(true);
    })().catch(() => {
      if (!cancelled) {
        localRecoveryFailedRef.current = true;
        recoveredDraftAtBootstrapRef.current = null;
        setLocalRecoveryResolved(true);
      }
    });

    return () => {
      cancelled = true;
      if (ownsPersistence) {
        persistence.close();
      }
    };
  }, [ownsPersistence, persistence]);

  useEffect(() => {
    if (!cloudConfigured) {
      return undefined;
    }

    let cancelled = false;
    void completeMagicLinkReturn()
      .then(() => readCurrentSession())
      .then((currentSession) => {
        if (!cancelled) {
          setSession(currentSession);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCloudReadiness({
            status: "degraded",
            reason: "authentication-unavailable",
          });
          setCaptureMessage(
            window.location.pathname === "/auth/confirm"
              ? "This sign-in link is invalid or has expired. Your work remains saved on this device."
              : "Your account session could not be checked. Your work remains saved on this device.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setInitialSessionResolved(true);
        }
      });
    const unsubscribe = subscribeToAuth((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [
    cloudConfigured,
    completeMagicLinkReturn,
    readCurrentSession,
    subscribeToAuth,
  ]);

  useEffect(() => {
    if (!cloudConfigured || !initialSessionResolved) {
      return undefined;
    }
    let cancelled = false;
    void probeCloudReadiness(session !== null).then((result) => {
      if (!cancelled) {
        setCloudReadiness(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    cloudConfigured,
    initialSessionResolved,
    probeCloudReadiness,
    session,
  ]);

  useEffect(() => {
    if (phase !== "recording") {
      return undefined;
    }

    const timer = setInterval(() => {
      setRecordingDurationSeconds(
        Math.max(
          0,
          Math.floor((performance.now() - recordingStartedAtRef.current) / 1_000),
        ),
      );
    }, 1_000);

    return () => clearInterval(timer);
  }, [phase]);

  const requestCloudSync = useCallback((): Promise<void> => {
    if (!session || !cloudConfigured || storyEditConflictRef.current) {
      return Promise.resolve();
    }

    cloudSyncRequestedRef.current = true;
    if (cloudSyncPromiseRef.current) {
      return cloudSyncPromiseRef.current;
    }

    const running = (async () => {
      let fullySynced: boolean;
      let attempts = 0;
      do {
        cloudSyncRequestedRef.current = false;
        attempts += 1;
        const before = await persistence.recoverGuestDraft();
        setPersistenceState(before?.migration_receipt ? "saving" : "securing");
        const outcome = await synchroniseActiveStory(
          persistence,
          createCloudPersistence(),
        );
        if (!outcome) {
          setPersistenceState("idle");
          return;
        }
        fullySynced = outcome?.fullySynced ?? true;
      } while (
        attempts < 3 &&
        (cloudSyncRequestedRef.current || !fullySynced)
      );

      setPersistenceState(fullySynced ? "saved" : "not-yet-synced");
      if (fullySynced) {
        setCloudReadiness({ status: "ready" });
        setCaptureMessage((message) =>
          message?.startsWith("Your story is still waiting to sync") ||
          message?.startsWith("Your previous story is still here") ||
          message?.startsWith("Your story text is safe") ||
          message?.startsWith("Your recording is safe") ||
          message?.startsWith("Your sign-in needs refreshing") ||
          message?.startsWith(
            "Your story could not be acknowledged by cloud saving",
          )
            ? null
            : message,
        );
      }
    })()
      .catch((error: unknown) => {
        console.warn(
          `[lived-experience] story-sync:${contentFreeFailureCode(error)}`,
        );
        if (error instanceof CloudStoryEditConflictError) {
          storyEditConflictRef.current = error;
          setStoryEditConflict(error);
          setHasVersionHistory(true);
        }
        if (!bootstrapSyncInProgressRef.current) {
          if (
            error instanceof CloudPersistenceError &&
            (error.code === "AUTH_REQUIRED" ||
              error.code === "AUTH_CHECK_FAILED")
          ) {
            setCloudReadiness({
              status: "degraded",
              reason: "authentication-unavailable",
            });
          } else if (!(error instanceof CloudStoryEditConflictError)) {
            setCloudReadiness({
              status: "degraded",
              reason: "cloud-unavailable",
            });
          }
          setPersistenceState("not-yet-synced");
          if (error instanceof CloudStoryEditConflictError) {
            setCaptureMessage(
              "This story was changed elsewhere. Both versions are safe. Review Version history and choose the one you want to continue with.",
            );
          } else {
            setCaptureMessage(cloudSyncFailureMessage(error));
          }
        }
      })
      .finally(() => {
        cloudSyncPromiseRef.current = null;
      });

    cloudSyncPromiseRef.current = running;
    return running;
  }, [
    cloudConfigured,
    createCloudPersistence,
    persistence,
    session,
    synchroniseActiveStory,
  ]);

  useEffect(() => {
    if (
      !localRecoveryResolved ||
      !initialSessionResolved ||
      bootstrapFinalisedRef.current
    ) {
      return;
    }
    let cancelled = false;

    const finishBootstrap = () => {
      if (cancelled) {
        return;
      }
      bootstrapFinalisedRef.current = true;
      setHydrated(true);
      hydrationGate.resolve();
    };

    const showRecoveredDraft = (
      recovered: RecoveredGuestDraft,
      recoveredAsGuest: boolean,
    ) => {
      if (textGenerationRef.current === 0) {
        setRecoveredDraft(recovered);
      } else {
        recoveredTextBeforeHydrationRef.current = recovered.story.current_text;
        currentStoryIdRef.current = recovered.story.client_story_id;
        setHasStarted(true);
        setHasOriginalAudio(
          recovered.audio_segments.some((segment) => segment.byte_size > 0),
        );
        setHasOriginalTranscript(recovered.original_transcripts.length > 0);
        setHasVersionHistory(recovered.story_versions.length > 0);
        const pending = pendingSegmentFrom(recovered);
        pendingSegmentRef.current = pending;
        setHasPendingSegment(pending !== null);
        setPendingTranscriptRetryable(pending !== null);
        setCanKeepPendingAudio(pending?.status === "finalised");
      }
      setIsRecoveredGuestDraft(recoveredAsGuest);
      const interruptedMessage = interruptedRecoveryMessageRef.current;
      if (interruptedMessage) {
        setCaptureMessage(interruptedMessage);
      }
    };

    void (async () => {
      let recovered = recoveredDraftAtBootstrapRef.current ?? null;
      let authReturnContext: AuthReturnContext | null = null;
      if (session) {
        try {
          authReturnContext = readAuthReturnContext();
        } catch {
          authReturnContext = null;
        }
        authReturnContextRef.current = authReturnContext;
      }
      const isAuthenticationReturn = authReturnContext !== null;
      const isMatchingAuthenticationReturn =
        recovered !== null &&
        authReturnContext?.clientStoryId === recovered.story.client_story_id;

      if (isMatchingAuthenticationReturn && authReturnContext && recovered) {
        const textLength = recovered.story.current_text.length;
        editorSelectionRef.current = {
          start: Math.min(authReturnContext.selectionStart, textLength),
          end: Math.min(authReturnContext.selectionEnd, textLength),
          direction: "none",
        };
      }

      if (session && recovered && !isAuthenticationReturn) {
        bootstrapSyncInProgressRef.current = true;
        await requestCloudSync();
        bootstrapSyncInProgressRef.current = false;
        recovered = await persistence.recoverGuestDraft();
        if (recovered) {
          try {
            await persistence.clearCloudAcknowledgedStory({
              client_story_id: recovered.story.client_story_id,
            });
            if (cancelled) {
              return;
            }
            resetForFreshCanvas(textGenerationRef.current > 0);
            finishBootstrap();
            return;
          } catch {
            // The guarded clear is authoritative. Any unacknowledged or
            // recording-related state stays on this device and remains open.
          }
        }
      }

      if (cancelled) {
        return;
      }
      if (recovered) {
        showRecoveredDraft(
          recovered,
          session === null && recovered.migration_receipt === null,
        );
        if (storyEditConflictRef.current) {
          setPersistenceState("not-yet-synced");
          setCaptureMessage(
            "This story was changed elsewhere. Both versions are safe. Review Version history and choose the one you want to continue with.",
          );
        } else if (
          session &&
          !isAuthenticationReturn &&
          !pendingSegmentFrom(recovered) &&
          !storyEditConflictRef.current
        ) {
          setPersistenceState("not-yet-synced");
          setCaptureMessage(
            "Your previous story is still here because it has not been fully saved to your account. Finish syncing it before starting a new story.",
          );
        } else if (
          session &&
          isAuthenticationReturn &&
          !isMatchingAuthenticationReturn
        ) {
          setCaptureMessage(
            "The story on this device changed while email sign-in was open, so it has been kept here for you to review.",
          );
        }
      } else {
        setIsRecoveredGuestDraft(false);
        if (isAuthenticationReturn) {
          setCaptureMessage(
            "Email sign-in finished, but no device-only story was available to restore. You can begin a new story here.",
          );
        }
      }

      if (localRecoveryFailedRef.current) {
        setDeviceReadiness({
          status: "blocked",
          reason: "device-storage-unavailable",
        });
        setPersistenceState("sync-error");
        setCaptureMessage(
          "This browser could not open device storage. Please keep this page open while you copy anything important.",
        );
      }
      finishBootstrap();
    })().catch(() => {
      if (!cancelled) {
        setPersistenceState("sync-error");
        setCaptureMessage(
          "This browser could not prepare your saved work safely. Nothing has been deliberately discarded.",
        );
        finishBootstrap();
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    hydrationGate,
    initialSessionResolved,
    localRecoveryResolved,
    persistence,
    readAuthReturnContext,
    requestCloudSync,
    resetForFreshCanvas,
    session,
    setRecoveredDraft,
  ]);

  useEffect(() => {
    if (!session) {
      return undefined;
    }
    const retryAfterReconnect = () => {
      if (currentStoryIdRef.current) {
        void requestCloudSync();
      }
    };
    window.addEventListener("online", retryAfterReconnect);
    return () => window.removeEventListener("online", retryAfterReconnect);
  }, [requestCloudSync, session]);

  const enqueueTextSave = useCallback(
    (text: string, generation: number): Promise<void> => {
      const operation = saveQueueRef.current.then(async () => {
        await hydrationGate.promise;
        let textToSave = text;
        const recoveredText = recoveredTextBeforeHydrationRef.current;
        if (recoveredText !== null) {
          const alreadyContainsRecoveredText =
            text === recoveredText || text.startsWith(`${recoveredText}\n\n`);
          if (
            recoveredText.length > 0 &&
            text !== recoveredText &&
            !alreadyContainsRecoveredText
          ) {
            const separator = text.length > 0 ? "\n\n" : "";
            const selectionOffset = recoveredText.length + separator.length;
            textToSave = `${recoveredText}${separator}${text}`;
            contentRef.current = textToSave;
            setContent(textToSave);
            editorSelectionRef.current = {
              start: editorSelectionRef.current.start + selectionOffset,
              end: editorSelectionRef.current.end + selectionOffset,
              direction: editorSelectionRef.current.direction,
            };
          }
        }
        const acknowledgement = await persistence.saveText({
          current_text: textToSave,
        });
        if (acknowledgement) {
          currentStoryIdRef.current = acknowledgement.value.client_story_id;
          setHasStarted(true);
        }

        if (generation !== textGenerationRef.current) {
          return;
        }

        recoveredTextBeforeHydrationRef.current = null;
        localSaveFailureGenerationRef.current = null;

        if (!acknowledgement) {
          setPersistenceState("idle");
        } else if (session) {
          setPersistenceState("not-yet-synced");
          void requestCloudSync();
        } else {
          setPersistenceState("saved-locally");
        }
      });

      saveQueueRef.current = operation.catch(() => {
        localSaveFailureGenerationRef.current = generation;
        if (generation === textGenerationRef.current) {
          setDeviceReadiness({
            status: "blocked",
            reason: "device-storage-unavailable",
          });
          setPersistenceState("sync-error");
          setCaptureMessage(
            "Your latest changes could not yet be saved on this device. Keep this page open and try typing again.",
          );
        }
      });
      return operation;
    },
    [hydrationGate, persistence, requestCloudSync, session],
  );

  const flushTextSave = useCallback(async (): Promise<void> => {
    await saveQueueRef.current;
    if (
      localSaveFailureGenerationRef.current === textGenerationRef.current
    ) {
      throw new Error("The latest local save was not acknowledged.");
    }
  }, []);

  const scheduleTextSave = useCallback(
    (text: string) => {
      textGenerationRef.current += 1;
      const generation = textGenerationRef.current;
      setPersistenceState("saving");
      void enqueueTextSave(text, generation).catch(() => undefined);
    },
    [enqueueTextSave],
  );

  const handleContentChange = useCallback(
    (nextContent: string) => {
      const previousContent = contentRef.current;
      const anchor = insertionAnchorRef.current;
      if (anchor) {
        anchor.position = mapTextPosition(
          anchor.previousText,
          nextContent,
          anchor.position,
        );
        anchor.previousText = nextContent;
      }
      contentRef.current = nextContent;
      setContent(nextContent);
      if (nextContent.length > 0) {
        setHasStarted(true);
      }
      if (phase === "empty") {
        setPhase("editing");
      } else if (phase === "error" && !pendingSegmentRef.current) {
        setPhase(phaseForContent(nextContent));
      }
      if (transcriptApplicationInFlightRef.current) {
        textGenerationRef.current += 1;
        setPersistenceState("saving");
      } else {
        scheduleTextSave(nextContent);
      }

      if (
        previousContent !== nextContent &&
        !pendingSegmentRef.current &&
        !emergencyAudioBackupRef.current &&
        !storyEditConflictRef.current
      ) {
        setCaptureMessage(null);
      }
    },
    [phase, scheduleTextSave],
  );

  const handleEditorSelectionChange = useCallback(
    (selection: EditorSelection) => {
      editorSelectionRef.current = selection;
      deliberateSelectionRef.current = true;
    },
    [],
  );

  const requestGuidancePrompt = useCallback(async (): Promise<void> => {
    if (
      phase === "recording" ||
      phase === "processing" ||
      deviceReadiness?.status === "blocked"
    ) {
      return;
    }
    guidancePromptAbortRef.current?.abort();
    const controller = new AbortController();
    guidancePromptAbortRef.current = controller;
    const requestGeneration = guidancePromptRequestRef.current + 1;
    guidancePromptRequestRef.current = requestGeneration;
    const previousPrompt = lastGuidancePromptRef.current;
    updateGuidancePromptState({ status: "loading" });
    try {
      const result = await generatePrompt({
        storyText: contentRef.current,
        previousPrompt,
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        requestGeneration !== guidancePromptRequestRef.current
      ) {
        return;
      }
      lastGuidancePromptRef.current = result.prompt;
      updateGuidancePromptState({
        status: "ready",
        prompt: result.prompt,
      });
    } catch (error) {
      if (
        controller.signal.aborted ||
        requestGeneration !== guidancePromptRequestRef.current ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return;
      }
      updateGuidancePromptState({
        status: "error",
        message:
          "A prompt isn’t available right now. Your story is unchanged.",
      });
    } finally {
      if (guidancePromptAbortRef.current === controller) {
        guidancePromptAbortRef.current = null;
      }
    }
  }, [
    deviceReadiness?.status,
    generatePrompt,
    phase,
    updateGuidancePromptState,
  ]);

  const prepareTranscript = useCallback(
    async (
      pending: PendingSegment,
      audioParts: readonly TranscriptionAudioPart[],
      durationMs: number,
    ): Promise<void> => {
      setPhase("processing");
      setCaptureMessage(null);
      setPendingTranscriptRetryable(false);
      setCanKeepPendingAudio(false);
      pendingSegmentRef.current = {
        ...pending,
        durationMs,
        status: "finalised",
      };
      setHasPendingSegment(true);

      try {
        const result = await transcribe({
          audioParts,
          segmentId: pending.clientSegmentId,
          durationMs,
        });
        transcriptApplicationInFlightRef.current = true;
        await flushTextSave();

        const beforeApplication = await persistence.recoverGuestDraft();
        if (!beforeApplication) {
          throw new Error(
            "The saved recording could not be linked to this story yet.",
          );
        }
        const applicationAnchor = insertionAnchorRef.current ?? {
          position: contentRef.current.length,
          previousText: contentRef.current,
        };
        const applicationText = insertTranscript(
          contentRef.current,
          result.text,
          {
            start: applicationAnchor.position,
            end: applicationAnchor.position,
          },
        );
        const applied = await persistence.applyOriginalTranscript({
          client_segment_id: pending.clientSegmentId,
          transcript_text: result.text,
          uncertainties: uncertaintyRecords(result.uncertainties),
          transcription_provider: result.provider,
          transcription_model: result.model,
          current_text: applicationText.text,
          expected_revision: beforeApplication.story.revision,
        });

        const latestAnchor = insertionAnchorRef.current ?? applicationAnchor;
        const inserted = insertTranscript(contentRef.current, result.text, {
          start: latestAnchor.position,
          end: latestAnchor.position,
        });
        contentRef.current = inserted.text;
        setContent(inserted.text);
        editorSelectionRef.current = {
          start: inserted.cursor,
          end: inserted.cursor,
          direction: "none",
        };
        insertionAnchorRef.current = null;
        deliberateSelectionRef.current = false;
        transcriptApplicationInFlightRef.current = false;

        textGenerationRef.current += 1;
        const generation = textGenerationRef.current;
        localSaveFailureGenerationRef.current = null;
        let latestTextSaved = true;
        if (inserted.text !== applied.value.story.current_text) {
          setPersistenceState("saving");
          try {
            await enqueueTextSave(inserted.text, generation);
          } catch {
            latestTextSaved = false;
          }
        }

        setHasOriginalAudio(true);
        setHasOriginalTranscript(true);
        setHasVersionHistory(true);
        pendingSegmentRef.current = null;
        setHasPendingSegment(false);
        setPendingTranscriptRetryable(false);
        setCanKeepPendingAudio(false);
        setPhase("editing");
        setPersistenceState(
          !latestTextSaved
            ? "sync-error"
            : generation !== textGenerationRef.current
            ? "saving"
            : session
              ? "not-yet-synced"
              : "saved-locally",
        );
        if (session) {
          void requestCloudSync();
        }
      } catch (error) {
        const typingChangedDuringApplication =
          transcriptApplicationInFlightRef.current;
        transcriptApplicationInFlightRef.current = false;
        if (typingChangedDuringApplication) {
          const generation = textGenerationRef.current;
          setPersistenceState("saving");
          try {
            await enqueueTextSave(contentRef.current, generation);
          } catch {
            // enqueueTextSave already exposes the unacknowledged local state.
          }
        } else {
          setPersistenceState(session ? "not-yet-synced" : "saved-locally");
        }
        setPhase("error");
        setPendingTranscriptRetryable(
          error instanceof TranscriptionError ? error.retryable : true,
        );
        setCanKeepPendingAudio(true);
        setCaptureMessage(
          error instanceof Error
            ? error.message
            : "The transcript could not be prepared yet. Your recording remains saved on this device.",
        );
      }
    },
    [
      enqueueTextSave,
      flushTextSave,
      persistence,
      requestCloudSync,
      session,
      transcribe,
    ],
  );

  const stopActiveRecording = useCallback(
    async (
      stoppedAtLimit = false,
      stoppedAtPartLimit = false,
    ): Promise<void> => {
      if (stopPromiseRef.current) {
        return stopPromiseRef.current;
      }

      const recorder = recorderRef.current;
      const clientSegmentId = activeSegmentIdRef.current;
      if (!recorder || !clientSegmentId) {
        return;
      }

      const stopping = (async () => {
        setPhase("processing");
        setRecordingDurationSeconds(0);
        try {
          const completed = await recorder.stop();
          const durationMs = Math.max(1, Math.min(30 * 60 * 1_000, completed.durationMs));
          if (completed.persistenceAcknowledged === false) {
            try {
              await recoverMissingRecordingWrites(
                persistence,
                clientSegmentId,
                completed,
              );
            } catch {
              emergencyAudioBackupRef.current = emergencyBackupFor(completed);
              setHasEmergencyAudioBackup(
                emergencyAudioBackupRef.current !== null,
              );
              pendingSegmentRef.current = null;
              setHasPendingSegment(false);
              setPendingTranscriptRetryable(false);
              setCanKeepPendingAudio(false);
              setPhase("error");
              setPersistenceState("sync-error");
              setCaptureMessage(
                emergencyAudioBackupRef.current
                  ? "This recording could not be secured on this device. Keep this page open and download the recording backup now."
                  : "This recording could not be secured on this device. Keep this page open while you copy any typed text you need.",
              );
              return;
            }
          }
          emergencyAudioBackupRef.current = null;
          setHasEmergencyAudioBackup(false);
          await persistence.finaliseAudioSegment({
            client_segment_id: clientSegmentId,
            duration_ms: durationMs,
          });
          setHasOriginalAudio(true);
          const pending: PendingSegment = {
            clientSegmentId,
            durationMs,
            mediaType: completed.mediaType,
            status: "finalised",
          };
          pendingSegmentRef.current = pending;
          setHasPendingSegment(true);
          setCanKeepPendingAudio(true);
          setPersistenceState(session ? "not-yet-synced" : "saved-locally");
          if (session) {
            void requestCloudSync();
          }
          if (stoppedAtPartLimit || completed.stoppedAtPartLimit) {
            setCaptureMessage(
              "This spoken segment reached the browser’s safe recording-size limit and was stopped safely. Your story remains open.",
            );
          } else if (stoppedAtLimit || completed.stoppedAtLimit) {
            setCaptureMessage(
              "This spoken segment reached the 30-minute limit and was stopped safely. Your story remains open.",
            );
          }
          await prepareTranscript(
            pending,
            transcriptionParts(completed),
            durationMs,
          );
        } catch (error) {
          let recoveredPending: PendingSegment | null = null;
          let interruptedTailPreserved = false;
          try {
            const chunks = await persistence.readAudioChunks(clientSegmentId);
            if (chunks.length > 0) {
              const outcome = (
                await persistence.recoverInterruptedAudioSegment(
                  clientSegmentId,
                )
              ).value;
              interruptedTailPreserved = outcome.unfinished_tail_preserved;
              if (outcome.segment) {
                recoveredPending = {
                  clientSegmentId,
                  durationMs: outcome.segment.duration_ms,
                  mediaType: outcome.segment.media_type,
                  status: "finalised",
                };
              }
            } else {
              await persistence.failAudioSegment({
                client_segment_id: clientSegmentId,
                failure_code: contentFreeFailureCode(error),
              });
            }
          } catch {
            // The earlier failure remains authoritative; no content is logged.
          }
          pendingSegmentRef.current = recoveredPending;
          setHasPendingSegment(recoveredPending !== null);
          setPendingTranscriptRetryable(recoveredPending !== null);
          setCanKeepPendingAudio(recoveredPending !== null);
          setPhase("error");
          setPersistenceState(
            recoveredPending
              ? session
                ? "not-yet-synced"
                : "saved-locally"
              : "sync-error",
          );
          setCaptureMessage(
            recoveredPending
              ? interruptedTailPreserved
                ? "The recording stopped unexpectedly. Its completed audio is saved; an unfinished tail remains on this device and may not play."
                : "The recording stopped unexpectedly. A best-effort audio copy is saved; playback may depend on what the browser finished."
              : "The recording stopped, but no audio could be secured on this device. Keep this page open and copy any typed text you need.",
          );
          if (recoveredPending && session) {
            void requestCloudSync();
          }
        } finally {
          recorderRef.current = null;
          activeSegmentIdRef.current = null;
          stopPromiseRef.current = null;
        }
      })();

      stopPromiseRef.current = stopping;
      return stopping;
    },
    [persistence, prepareTranscript, requestCloudSync, session],
  );

  const beginRecording = useCallback(async (): Promise<void> => {
    if (
      recorderRef.current ||
      phase === "processing" ||
      pendingSegmentRef.current
    ) {
      if (pendingSegmentRef.current) {
        setCaptureMessage(
          "Prepare the saved recording’s transcript before starting another recording.",
        );
      }
      return;
    }

    cancelGuidancePrompt();
    setMicrophoneDialog(null);
    setCaptureMessage(null);
    const latestDeviceReadiness = await probeDeviceReadiness(persistence);
    setDeviceReadiness(latestDeviceReadiness);
    if (latestDeviceReadiness.status === "blocked") {
      return;
    }
    try {
      await flushTextSave();
    } catch {
      setPersistenceState("sync-error");
      setCaptureMessage(
        "Recording has not started because your latest typing is not yet secure on this device.",
      );
      return;
    }

    let resolveSegment!: (id: Uuid) => void;
    let rejectSegment!: (reason: unknown) => void;
    const segmentReady = new Promise<Uuid>((resolve, reject) => {
      resolveSegment = resolve;
      rejectSegment = reject;
    });
    void segmentReady.catch(() => undefined);
    const recorder = createRecorder({
      onChunk: async (chunk) => {
        const clientSegmentId = await segmentReady;
        await persistence.appendAudioChunk({
          client_segment_id: clientSegmentId,
          chunk_sequence_number: chunk.sequenceNumber,
          part_sequence_number: chunk.partSequenceNumber ?? 1,
          part_chunk_sequence_number:
            chunk.partChunkSequenceNumber ?? chunk.sequenceNumber,
          part_start_offset_ms: chunk.partStartOffsetMs ?? 0,
          part_elapsed_ms: chunk.partElapsedMs ?? 1,
          blob: chunk.blob,
        });
        setHasOriginalAudio(true);
        // More audio is still being captured after this acknowledged chunk.
        setPersistenceState("saving");
      },
      onPartCompleted: async (part) => {
        const clientSegmentId = await segmentReady;
        await persistence.finaliseAudioPart({
          client_segment_id: clientSegmentId,
          part_sequence_number: part.sequenceNumber,
          duration_ms: part.durationMs,
        });
      },
      onDurationLimit: () => {
        void stopActiveRecording(true);
      },
      onPartLimit: () => {
        void stopActiveRecording(false, true);
      },
      onPersistenceFailure: () => {
        void stopActiveRecording(false);
      },
      onError: () => {
        void stopActiveRecording(false);
      },
    });
    recorderRef.current = recorder;
    let microphoneStarted = false;

    try {
      const mediaType = await recorder.start();
      microphoneStarted = true;
      const segment = await persistence.createAudioSegment({
        media_type: mediaType,
      });
      activeSegmentIdRef.current = segment.value.client_segment_id;
      resolveSegment(segment.value.client_segment_id);
      currentStoryIdRef.current = segment.value.client_story_id;
      pendingSegmentRef.current = null;
      setHasPendingSegment(false);
      setPendingTranscriptRetryable(false);
      setCanKeepPendingAudio(false);
      insertionAnchorRef.current = {
        position: deliberateSelectionRef.current
          ? editorSelectionRef.current.start
          : contentRef.current.length,
        previousText: contentRef.current,
      };
      deliberateSelectionRef.current = false;
      recordingStartedAtRef.current = performance.now();
      setRecordingDurationSeconds(0);
      setHasStarted(true);
      setPersistenceState("saving");
      setPhase("recording");
    } catch (error) {
      rejectSegment(error);
      let inMemoryBackup: EmergencyAudioBackup | null = null;
      if (microphoneStarted) {
        const completed = await recorder.stop().catch(() => null);
        if (completed) {
          inMemoryBackup = emergencyBackupFor(completed);
        }
      }
      recorderRef.current = null;
      activeSegmentIdRef.current = null;
      if (inMemoryBackup) {
        setDeviceReadiness({
          status: "blocked",
          reason: "device-storage-unavailable",
        });
        emergencyAudioBackupRef.current = inMemoryBackup;
        setHasEmergencyAudioBackup(true);
        setMicrophoneDialog(null);
        setPhase("error");
        setPersistenceState("sync-error");
        setCaptureMessage(
          "This recording could not be secured on this device. Keep this page open and download the recording backup now.",
        );
        return;
      }
      const kind =
        typeof error === "object" &&
        error !== null &&
        "kind" in error &&
        typeof error.kind === "string"
          ? (error.kind as MicrophoneFailureKind)
          : "error";
      setMicrophoneDialog(microphoneDialogFor(kind));
      setPhase(phaseForContent(contentRef.current));
    }
  }, [
    createRecorder,
    cancelGuidancePrompt,
    flushTextSave,
    persistence,
    phase,
    probeDeviceReadiness,
    stopActiveRecording,
  ]);

  const retryPendingTranscript = useCallback((): Promise<void> => {
    if (retryPromiseRef.current) {
      return retryPromiseRef.current;
    }
    const retry = (async () => {
      const pending = pendingSegmentRef.current;
      if (!pending) {
        return;
      }

      try {
        const chunks = await persistence.readAudioChunks(
          pending.clientSegmentId,
        );
        if (chunks.length === 0) {
          await persistence.failAudioSegment({
            client_segment_id: pending.clientSegmentId,
            failure_code: "empty-recording",
          });
          pendingSegmentRef.current = null;
          setHasPendingSegment(false);
          setPendingTranscriptRetryable(false);
          setCanKeepPendingAudio(false);
          const recovered = await persistence.recoverGuestDraft();
          const hasRecoverableAudio =
            recovered?.audio_segments.some(
              (segment) => segment.byte_size > 0,
            ) ?? false;
          const isNowEmptyGuestDraft =
            recovered !== null &&
            recovered.migration_receipt === null &&
            recovered.story.current_text.length === 0 &&
            !hasRecoverableAudio;
          if (isNowEmptyGuestDraft) {
            await persistence.discardGuestDraft({
              client_story_id: recovered.story.client_story_id,
            });
            currentStoryIdRef.current = null;
            setHasStarted(false);
          }
          setHasOriginalAudio(hasRecoverableAudio);
          setPhase(phaseForContent(contentRef.current));
          setPersistenceState(
            isNowEmptyGuestDraft
              ? "idle"
              : session
                ? "not-yet-synced"
                : "saved-locally",
          );
          setCaptureMessage(
            "No audio was captured in that interrupted attempt. You can start another recording.",
          );
          if (session) {
            void requestCloudSync();
          }
          return;
        }

        let finalPending = pending;
        let parts: readonly StandaloneAudioPart[];
        if (pending.status === "recording" || pending.durationMs < 1) {
          const outcome = (
            await persistence.recoverInterruptedAudioSegment(
              pending.clientSegmentId,
            )
          ).value;
          if (!outcome.segment || outcome.parts.length === 0) {
            throw new Error("No playable interrupted audio was verified.");
          }
          finalPending = {
            ...pending,
            durationMs: outcome.segment.duration_ms,
            status: "finalised",
          };
          pendingSegmentRef.current = finalPending;
          setCanKeepPendingAudio(true);
          parts = outcome.parts;
        } else {
          parts = await persistence.readAudioParts(pending.clientSegmentId);
        }
        await prepareTranscript(
          finalPending,
          parts.map((part) => ({
            audio: part.blob,
            durationMs: part.duration_ms,
            startOffsetMs: part.start_offset_ms,
          })),
          finalPending.durationMs,
        );
      } catch {
        setPhase("error");
        setPendingTranscriptRetryable(true);
        setCaptureMessage(
          "The saved recording could not be prepared yet. It remains on this device so you can try again or keep the audio and continue.",
        );
      }
    })();
    retryPromiseRef.current = retry;
    void retry.finally(() => {
      if (retryPromiseRef.current === retry) {
        retryPromiseRef.current = null;
      }
    });
    return retry;
  }, [persistence, prepareTranscript, requestCloudSync, session]);

  const keepAudioAndContinue = useCallback(async (): Promise<void> => {
    const pending = pendingSegmentRef.current;
    if (!pending || pending.status !== "finalised") {
      return;
    }
    try {
      await persistence.skipAudioTranscription({
        client_segment_id: pending.clientSegmentId,
      });
      clearPartialTranscriptionCache(pending.clientSegmentId);
      pendingSegmentRef.current = null;
      setHasPendingSegment(false);
      setPendingTranscriptRetryable(false);
      setCanKeepPendingAudio(false);
      setHasOriginalAudio(true);
      setPhase(phaseForContent(contentRef.current));
      setPersistenceState(session ? "not-yet-synced" : "saved-locally");
      setCaptureMessage(
        "Your original recording is kept without a transcript. You can continue your story whenever you’re ready.",
      );
      if (session) {
        void requestCloudSync();
      }
    } catch {
      setPhase("error");
      setCaptureMessage(
        "The recording is still here, but this browser could not confirm that choice yet. Please try again.",
      );
    }
  }, [persistence, requestCloudSync, session]);

  const downloadEmergencyAudio = useCallback(() => {
    const backup = emergencyAudioBackupRef.current;
    if (!backup) {
      return;
    }
    backup.blobs.forEach((blob, index) => {
      const source = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const extension = blob.type.includes("mp4")
        ? "m4a"
        : blob.type.includes("ogg")
          ? "ogg"
          : "webm";
      link.download = `lived-experience-recording-backup-${index + 1}.${extension}`;
      link.href = source;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(source), 0);
    });
    emergencyAudioBackupRef.current = null;
    setHasEmergencyAudioBackup(false);
    setCaptureMessage(
      "The recording backup download has started. Keep the downloaded file somewhere private.",
    );
  }, []);

  const discardRecoveredGuestDraft = useCallback(async (): Promise<void> => {
    setDiscardDraftDialogOpen(false);
    if (
      session ||
      !isRecoveredGuestDraft ||
      phase === "recording" ||
      phase === "processing" ||
      emergencyAudioBackupRef.current
    ) {
      setCaptureMessage(
        "This draft cannot be discarded while capture or saving still needs attention.",
      );
      return;
    }
    try {
      await flushTextSave();
      const clientStoryId = currentStoryIdRef.current;
      if (!clientStoryId) {
        resetForFreshCanvas();
        return;
      }
      await persistence.discardGuestDraft({
        client_story_id: clientStoryId,
      });
      resetForFreshCanvas();
    } catch {
      setPersistenceState("sync-error");
      setCaptureMessage(
        "This draft was not discarded because the browser could not confirm the change. It remains on this device.",
      );
    }
  }, [
    flushTextSave,
    isRecoveredGuestDraft,
    persistence,
    phase,
    resetForFreshCanvas,
    session,
  ]);

  const startNewStory = useCallback(async (): Promise<void> => {
    if (
      !session ||
      !hasStarted ||
      phase === "recording" ||
      phase === "processing" ||
      pendingSegmentRef.current ||
      emergencyAudioBackupRef.current ||
      storyEditConflictRef.current
    ) {
      setCaptureMessage(
        "Finish the current recording and wait until every change is saved before starting a new story.",
      );
      return;
    }

    try {
      await flushTextSave();
      await requestCloudSync();
      const active = await persistence.recoverGuestDraft();
      if (!active) {
        resetForFreshCanvas();
        return;
      }
      await persistence.clearCloudAcknowledgedStory({
        client_story_id: active.story.client_story_id,
      });
      resetForFreshCanvas();
    } catch {
      setPersistenceState("not-yet-synced");
      setCaptureMessage(
        "A new story has not started because the current story is not fully saved to your account. Your work remains on this device.",
      );
    }
  }, [
    flushTextSave,
    hasStarted,
    persistence,
    phase,
    requestCloudSync,
    resetForFreshCanvas,
    session,
  ]);

  const handleSendMagicLink = useCallback(async (
    email: string,
  ): Promise<MagicLinkRequestResult> => {
    if (emergencyAudioBackupRef.current) {
      const message =
        "Download the unsaved recording backup before signing in by email.";
      setCaptureMessage(message);
      return { ok: false, message };
    }
    if (phase === "processing" || transcriptApplicationInFlightRef.current) {
      const message =
        "Email sign-in will be available when the saved recording’s transcript is ready.";
      setCaptureMessage(message);
      return { ok: false, message };
    }
    try {
      await flushTextSave();
    } catch {
      setPersistenceState("sync-error");
      const message =
        "The sign-in link was not sent because your latest typing is not yet secure on this device.";
      setCaptureMessage(message);
      return { ok: false, message };
    }
    const clientStoryId = currentStoryIdRef.current;
    if (!clientStoryId || !cloudConfigured) {
      const message =
        "Email sign-in is not connected in this environment yet. This story remains saved on this device.";
      setCaptureMessage(message);
      return { ok: false, message };
    }

    try {
      await startEmailContinuation(
        email,
        {
          clientStoryId,
          selectionStart: editorSelectionRef.current.start,
          selectionEnd: editorSelectionRef.current.end,
        },
      );
      setCaptureMessage(
        "A secure sign-in link has been sent. This story remains saved on this device until you return through the link.",
      );
      return { ok: true };
    } catch {
      setPersistenceState("saved-locally");
      const message =
        "The sign-in link could not be sent. This story remains saved on this device.";
      setCaptureMessage(message);
      return { ok: false, message };
    }
  }, [cloudConfigured, flushTextSave, phase, startEmailContinuation]);

  const loadStoryLibrary = useCallback(async (): Promise<void> => {
    if (!session || !cloudConfigured) {
      setLibraryLoading(false);
      setLibraryError("Your private story library is not connected here yet.");
      return;
    }

    setLibraryLoading(true);
    setLibraryError(null);
    try {
      const summaries = await createCloudPersistence().listStories();
      setLibraryItems(
        summaries.map((story) => ({
          id: story.id,
          title: story.title,
          capturedAt: story.captured_at,
          updatedAt: story.updated_at,
          excerpt: story.excerpt,
          totalVoiceDurationMs: story.total_voice_duration_ms,
        })),
      );
    } catch {
      setLibraryError(
        "Your private stories could not be loaded yet. Your current work is unchanged.",
      );
    } finally {
      setLibraryLoading(false);
    }
  }, [cloudConfigured, createCloudPersistence, session]);

  const handleOpenStoryLibrary = useCallback(() => {
    setStorySurface("library");
    void loadStoryLibrary();
  }, [loadStoryLibrary]);

  const handleOpenStoryVisualisation = useCallback(() => {
    setStorySurface("visualisation");
    void loadStoryLibrary();
  }, [loadStoryLibrary]);

  const handleDismissStoryVisualisation = useCallback(() => {
    restoreVisualisationFocusRef.current = true;
    setStorySurface(null);
  }, []);

  const handleOpenCloudStory = useCallback(
    async (storyId: string): Promise<void> => {
      if (!session) {
        return;
      }
      cancelGuidancePrompt(true);
      setLibraryLoading(true);
      setLibraryError(null);
      try {
        await flushTextSave();
        await requestCloudSync();
        const active = await persistence.recoverGuestDraft();
        if (active && pendingSegmentFrom(active)) {
          setLibraryError(
            "Prepare the saved recording’s transcript before opening another story.",
          );
          return;
        }
        if (active && active.migration_outbox.state !== "completed") {
          setLibraryError(
            "Your current story is not yet synced, so another story cannot be opened safely.",
          );
          return;
        }

        const opened = await createCloudPersistence().openStory(
          storyId as Uuid,
        );
        const adoption = {
          owner_id: opened.story.owner_id,
          story_id: opened.story.id,
          client_story_id: opened.story.client_story_id,
          title: opened.story.title,
          current_text: opened.story.current_text,
          cloud_revision: opened.story.revision,
          cloud_version_id: opened.story.current_version_id,
          captured_at: Date.parse(opened.story.captured_at),
        } as const;
        const isAlreadyActive =
          active?.migration_receipt?.story_id === opened.story.id &&
          active.story.client_story_id === opened.story.client_story_id;
        if (!isAlreadyActive) {
          if (active) {
            await persistence.replaceActiveWithCloudStory({
              ...adoption,
              expected_current_client_story_id:
                active.story.client_story_id,
            });
          } else {
            await persistence.adoptCloudStory(adoption);
          }
        }

        contentRef.current = opened.story.current_text;
        setContent(opened.story.current_text);
        currentStoryIdRef.current = opened.story.client_story_id;
        editorSelectionRef.current = {
          start: opened.story.current_text.length,
          end: opened.story.current_text.length,
          direction: "none",
        };
        deliberateSelectionRef.current = false;
        insertionAnchorRef.current = null;
        pendingSegmentRef.current = null;
        setHasPendingSegment(false);
        setPendingTranscriptRetryable(false);
        setCanKeepPendingAudio(false);
        setHasStarted(true);
        setHasOriginalAudio(opened.audio_segments.length > 0);
        setHasOriginalTranscript(opened.original_transcripts.length > 0);
        setHasVersionHistory(opened.versions.length > 0);
        setPhase(phaseForContent(opened.story.current_text));
        setPersistenceState("saved");
        storyEditConflictRef.current = null;
        setStoryEditConflict(null);
        setCaptureMessage(null);
        setStorySurface(null);
      } catch {
        setLibraryError(
          "This story could not be opened yet. Your current work is unchanged.",
        );
      } finally {
        setLibraryLoading(false);
      }
    },
    [
      cancelGuidancePrompt,
      createCloudPersistence,
      flushTextSave,
      persistence,
      requestCloudSync,
      session,
    ],
  );

  const loadStoryArtefacts = useCallback(
    async (mode: StoryArtefactsMode): Promise<void> => {
      if (!storyEditConflictRef.current) {
        setCaptureMessage(null);
      }
      try {
        let recovered = await persistence.recoverGuestDraft();
        if (!recovered) {
          setCaptureMessage("There is no saved story to review yet.");
          return;
        }
        if (mode === "versions" && storyEditConflictRef.current) {
          await persistence.ensureCurrentStoryVersion({
            reason: "conflict-choice",
          });
          recovered = await persistence.recoverGuestDraft();
          if (!recovered) {
            throw new Error("The current story is unavailable.");
          }
        }

        let opened: CloudOpenedStory | null = null;
        let cloudReadFailed = false;
        if (
          session &&
          recovered.migration_receipt &&
          cloudConfigured
        ) {
          try {
            opened = await createCloudPersistence().openStory(
              recovered.migration_receipt.story_id,
            );
          } catch {
            cloudReadFailed = true;
          }
        }

        clearArtefactMedia();
        const audioItems: StoryAudioArtefact[] = [];
        const transcriptItems: StoryTranscriptArtefact[] = [];
        const versionItems: StoryVersionArtefact[] = [];
        let audioReadFailed = false;

        const cloudAudioByClientId = new Map(
          (opened?.audio_segments ?? []).map((segment) => [
            segment.client_segment_id,
            segment,
          ]),
        );
        if (mode === "audio" || mode === "transcript") {
          for (const segment of [...recovered.audio_segments].sort(
            (left, right) => left.sequence_number - right.sequence_number,
          )) {
            if (segment.byte_size < 1) {
              continue;
            }
            try {
              const parts = await persistence.readAudioParts(
                segment.client_segment_id,
              );
              if (parts.length === 0) {
                continue;
              }
              const sources: ArtefactAudioPartSource[] = [];
              for (const part of parts) {
                if (part.blob.size < 1) {
                  continue;
                }
                const src = URL.createObjectURL(part.blob);
                artefactObjectUrlsRef.current.add(src);
                sources.push({
                  src,
                  startOffsetMs: part.start_offset_ms,
                  durationMs: part.duration_ms,
                });
              }
              if (sources.length === 0) {
                continue;
              }
              audioItems.push({
                id: segment.client_segment_id,
                recordedAt: isoFromTimestamp(segment.recorded_at),
                durationMs: segment.duration_ms,
                parts: sources,
              });
              artefactAudioSourcesRef.current.set(
                segment.client_segment_id,
                sources,
              );
              const matchingCloudAudio = cloudAudioByClientId.get(
                segment.client_segment_id,
              );
              if (matchingCloudAudio) {
                artefactAudioSourcesRef.current.set(
                  matchingCloudAudio.id,
                  sources,
                );
              }
            } catch {
              audioReadFailed = true;
            }
          }

          if (opened) {
            const cloud = createCloudPersistence();
            for (const segment of [...opened.audio_segments].sort(
              (left, right) => left.sequence_number - right.sequence_number,
            )) {
              const existingSources = artefactAudioSourcesRef.current.get(
                segment.client_segment_id,
              );
              if (existingSources) {
                artefactAudioSourcesRef.current.set(
                  segment.id,
                  existingSources,
                );
                continue;
              }
              try {
                const parts = opened.audio_parts
                  .filter((part) => part.audio_segment_id === segment.id)
                  .sort((left, right) => left.part_number - right.part_number);
                const sources: ArtefactAudioPartSource[] = [];
                for (const part of parts) {
                  const downloaded = await cloud.downloadAudio(
                    part.storage_object_name,
                  );
                  const playable =
                    downloaded.type === part.media_type
                      ? downloaded
                      : new Blob([downloaded], { type: part.media_type });
                  const src = URL.createObjectURL(playable);
                  artefactObjectUrlsRef.current.add(src);
                  sources.push({
                    src,
                    startOffsetMs: part.start_offset_ms,
                    durationMs: part.duration_ms,
                  });
                }
                if (sources.length === 0) {
                  audioReadFailed = true;
                  continue;
                }
                audioItems.push({
                  id: segment.id,
                  recordedAt: segment.recorded_at,
                  durationMs: segment.duration_ms,
                  parts: sources,
                });
                artefactAudioSourcesRef.current.set(segment.id, sources);
                artefactAudioSourcesRef.current.set(
                  segment.client_segment_id,
                  sources,
                );
              } catch {
                audioReadFailed = true;
              }
            }
          }
        }

        const transcriptIds = new Set<string>();
        for (const transcript of recovered.original_transcripts) {
          transcriptIds.add(transcript.client_transcript_id);
          transcriptItems.push({
            id: transcript.client_transcript_id,
            createdAt: isoFromTimestamp(transcript.created_at),
            text: transcript.transcript_text,
            uncertainties: transcript.uncertainties
              .map(transcriptUncertaintyForDisplay)
              .filter(
                (uncertainty): uncertainty is StoryTranscriptUncertainty =>
                  uncertainty !== null,
              ),
            audioId: transcript.client_segment_id,
          });
        }
        for (const transcript of opened?.original_transcripts ?? []) {
          if (transcriptIds.has(transcript.id)) {
            continue;
          }
          transcriptIds.add(transcript.id);
          transcriptItems.push({
            id: transcript.id,
            createdAt: transcript.created_at,
            text: transcript.transcript_text,
            uncertainties: transcript.uncertainties
              .map(transcriptUncertaintyForDisplay)
              .filter(
                (uncertainty): uncertainty is StoryTranscriptUncertainty =>
                  uncertainty !== null,
              ),
            audioId: transcript.audio_segment_id,
          });
        }
        transcriptItems.sort(
          (left, right) =>
            Date.parse(left.createdAt) - Date.parse(right.createdAt),
        );

        const versionIds = new Set<string>();
        const conflict = storyEditConflictRef.current;
        const deviceVersionId = conflict
          ? recovered.story.current_version_id
          : null;
        const accountVersionId =
          conflict?.incumbent_story.current_version_id ?? null;
        const accountSourceId = conflict
          ? accountVersionId ?? `account-conflict-${conflict.conflict.id}`
          : null;
        for (const version of recovered.story_versions) {
          versionIds.add(version.client_version_id);
          artefactVersionSourcesRef.current.set(version.client_version_id, {
            localVersionId: version.client_version_id,
            cloudVersionId: null,
            text: version.story_text,
          });
          versionItems.push({
            id: version.client_version_id,
            createdAt: isoFromTimestamp(version.created_at),
            reason: version.reason,
            text: version.story_text,
            ...(version.client_version_id === deviceVersionId
              ? { conflictRole: "device" as const }
              : version.client_version_id === accountVersionId
                ? { conflictRole: "account" as const }
                : {}),
          });
        }
        for (const version of opened?.versions ?? []) {
          if (versionIds.has(version.id)) {
            continue;
          }
          versionIds.add(version.id);
          artefactVersionSourcesRef.current.set(version.id, {
            localVersionId: null,
            cloudVersionId: version.id,
            text: version.story_text,
          });
          versionItems.push({
            id: version.id,
            createdAt: version.created_at,
            reason: version.reason,
            text: version.story_text,
            ...(version.id === accountVersionId
              ? { conflictRole: "account" as const }
              : {}),
          });
        }
        if (conflict && accountSourceId && !versionIds.has(accountSourceId)) {
          versionIds.add(accountSourceId);
          artefactVersionSourcesRef.current.set(accountSourceId, {
            localVersionId: null,
            cloudVersionId: accountVersionId,
            text: conflict.incumbent_story.current_text,
          });
          versionItems.push({
            id: accountSourceId,
            createdAt: conflict.incumbent_story.updated_at,
            reason: "account-saved-conflict",
            text: conflict.incumbent_story.current_text,
            conflictRole: "account",
          });
        }
        versionItems.sort(
          (left, right) =>
            Date.parse(left.createdAt) - Date.parse(right.createdAt),
        );

        const requestedItemCount =
          mode === "audio"
            ? audioItems.length
            : mode === "transcript"
              ? transcriptItems.length
              : versionItems.length;
        if (
          requestedItemCount === 0 &&
          (cloudReadFailed || (mode === "audio" && audioReadFailed))
        ) {
          throw new Error("The requested artefacts are unavailable.");
        }

        setArtefactAudioItems(audioItems);
        setArtefactTranscriptItems(transcriptItems);
        setArtefactVersionItems(versionItems);
        setArtefactsMode(mode);
        if (cloudReadFailed || audioReadFailed) {
          setCaptureMessage(
            "Some account-saved originals could not be opened yet. Anything shown here is the recoverable copy currently available.",
          );
        }
      } catch {
        clearArtefactMedia();
        setCaptureMessage(
          "These originals could not be opened yet. Your current story is unchanged.",
        );
      }
    },
    [
      clearArtefactMedia,
      cloudConfigured,
      createCloudPersistence,
      persistence,
      session,
    ],
  );

  const handleDismissArtefacts = useCallback(() => {
    setArtefactsMode(null);
    clearArtefactMedia();
  }, [clearArtefactMedia]);

  const handleReviewConflictVersions = useCallback(async (): Promise<void> => {
    try {
      await flushTextSave();
      await loadStoryArtefacts("versions");
    } catch {
      setCaptureMessage(
        "Version history is waiting for the latest device save. Both versions remain safe.",
      );
    }
  }, [flushTextSave, loadStoryArtefacts]);

  const handlePlayUncertainty = useCallback(
    (audioId: string, audioStartMs: number) => {
      const parts = artefactAudioSourcesRef.current.get(audioId);
      const selected = parts?.find(
        (part) =>
          audioStartMs >= part.startOffsetMs &&
          audioStartMs < part.startOffsetMs + part.durationMs,
      ) ?? parts?.[0];
      if (!selected) {
        setCaptureMessage(
          "The linked recording could not be opened yet. The transcript remains unchanged.",
        );
        return;
      }

      uncertaintyPlayerRef.current?.pause();
      const player = new Audio(selected.src);
      uncertaintyPlayerRef.current = player;
      const playAtOffset = () => {
        player.currentTime = Math.max(
          0,
          (audioStartMs - selected.startOffsetMs) / 1_000,
        );
        void player.play().catch(() => {
          setCaptureMessage(
            "Playback could not start automatically. Open the original audio to play it with the browser controls.",
          );
        });
      };
      if (player.readyState >= HTMLMediaElement.HAVE_METADATA) {
        playAtOffset();
      } else {
        player.addEventListener("loadedmetadata", playAtOffset, { once: true });
        player.addEventListener(
          "error",
          () => {
            setCaptureMessage(
              "The linked recording could not be played. The original remains saved.",
            );
          },
          { once: true },
        );
      }
    },
    [],
  );

  const handleRestoreVersion = useCallback(
    async (versionId: string): Promise<void> => {
      const source = artefactVersionSourcesRef.current.get(versionId);
      if (!source) {
        return;
      }

      try {
        await flushTextSave();
        let restoredText: string;
        const conflict = storyEditConflictRef.current;
        if (conflict) {
          const active = await persistence.recoverGuestDraft();
          if (
            !active ||
            active.migration_receipt?.story_id !==
              conflict.incumbent_story.id
          ) {
            throw new Error("The current conflict is unavailable.");
          }
          const acknowledgement =
            await persistence.resolveCloudStoryConflict({
              client_story_id: active.story.client_story_id,
              story_id: conflict.incumbent_story.id,
              expected_story_revision: active.story.revision,
              expected_acknowledged_cloud_revision:
                conflict.conflict.expected_revision,
              incumbent_cloud_revision:
                conflict.incumbent_story.revision,
              incumbent_cloud_version_id:
                conflict.incumbent_story.current_version_id,
              selection: source.localVersionId
                ? {
                    kind: "local-version",
                    client_version_id: source.localVersionId,
                  }
                : {
                    kind: "account-version",
                    story_text: source.text,
                    cloud_version_id: source.cloudVersionId,
                  },
            });
          restoredText = acknowledgement.value.story.current_text;
          storyEditConflictRef.current = null;
          setStoryEditConflict(null);
        } else if (source.localVersionId) {
          const acknowledgement = await persistence.restoreStoryVersion({
            client_version_id: source.localVersionId,
          });
          restoredText = acknowledgement.value.story.current_text;
        } else {
          const active = await persistence.recoverGuestDraft();
          if (!active) {
            throw new Error("The current story is unavailable.");
          }
          const acknowledgement = await persistence.restoreExternalStoryText({
            story_text: source.text,
            expected_revision: active.story.revision,
          });
          restoredText = acknowledgement.value.story.current_text;
        }

        textGenerationRef.current += 1;
        contentRef.current = restoredText;
        setContent(restoredText);
        editorSelectionRef.current = {
          start: restoredText.length,
          end: restoredText.length,
          direction: "none",
        };
        deliberateSelectionRef.current = false;
        insertionAnchorRef.current = null;
        setHasVersionHistory(true);
        setPhase(phaseForContent(restoredText));
        setPersistenceState(session ? "not-yet-synced" : "saved-locally");
        setCaptureMessage(
          conflict
            ? "That version is now current. The other version remains recoverable."
            : "That earlier version is now current. Later versions remain recoverable.",
        );
        handleDismissArtefacts();
        if (session) {
          void requestCloudSync();
        }
      } catch {
        handleDismissArtefacts();
        setCaptureMessage(
          storyEditConflictRef.current
            ? "That choice could not be saved yet. Both versions remain safe; review them again."
            : "That version could not be restored yet. Your current story is unchanged.",
        );
      }
    },
    [
      flushTextSave,
      handleDismissArtefacts,
      persistence,
      requestCloudSync,
      session,
    ],
  );

  useEffect(() => {
    if (!session || !hydrated) {
      return;
    }
    let returnContext = authReturnContextRef.current;
    if (returnContext === undefined) {
      try {
        returnContext = readAuthReturnContext();
      } catch {
        returnContext = null;
      }
      authReturnContextRef.current = returnContext;
    }
    if (
      returnContext &&
      returnContext.clientStoryId === currentStoryIdRef.current
    ) {
      const textLength = contentRef.current.length;
      editorSelectionRef.current = {
        start: Math.min(returnContext.selectionStart, textLength),
        end: Math.min(returnContext.selectionEnd, textLength),
        direction: "none",
      };
    }
    if (currentStoryIdRef.current) {
      void requestCloudSync();
    }
  }, [hydrated, readAuthReturnContext, requestCloudSync, session]);

  const captureDisabled = deviceReadiness?.status === "blocked";
  const readinessNotice: CaptureReadinessNotice | null =
    deviceReadiness?.status === "blocked"
      ? {
          tone: "blocking",
          message:
            deviceReadiness.reason === "device-storage-low"
              ? "This device is too low on browser storage to safely begin a story. Free some storage, then reload this page."
              : "This browser cannot safely save a story on this device right now. Try reloading or use another supported browser before you begin.",
        }
      : cloudReadiness?.status === "degraded"
        ? {
            tone: "warning",
            message:
              cloudReadiness.reason === "authentication-unavailable"
                ? "Your sign-in needs refreshing. Anything you add will stay on this device until you sign in again."
                : "Cloud saving is temporarily unavailable. Anything you add will stay on this device and sync when the connection returns.",
          }
        : null;
  const microphoneWarning =
    microphoneDialog === "explanation" &&
    transcriptionReadiness?.status === "degraded"
      ? "Recording can be saved on this device, but transcription may be delayed."
      : null;

  return (
    <>
      {storySurface !== "visualisation" ? (
        <CaptureCanvas
        captureMessage={captureMessage}
        captureDisabled={captureDisabled}
        content={content}
        discardDraftDialogOpen={discardDraftDialogOpen}
        emailDialogOpen={emailDialogOpen}
        emailSignInAvailable={cloudConfigured}
        hasOriginalAudio={hasOriginalAudio}
        hasOriginalTranscript={hasOriginalTranscript}
        hasPendingRecording={hasPendingSegment}
        hasStarted={hasStarted}
        hasVersionHistory={hasVersionHistory}
        guidancePromptState={guidancePromptState}
        isAuthenticated={session !== null}
        microphoneDialog={microphoneDialog}
        microphoneWarning={microphoneWarning}
        onConfirmMicrophone={() => void beginRecording()}
        onContentChange={handleContentChange}
        onSendMagicLink={handleSendMagicLink}
        onConfirmDiscardRecoveredDraft={() =>
          void discardRecoveredGuestDraft()
        }
        onDiscardRecoveredDraft={
          hydrated && !session && isRecoveredGuestDraft
            ? () => setDiscardDraftDialogOpen(true)
            : undefined
        }
        onDismissDiscardRecoveredDraft={() =>
          setDiscardDraftDialogOpen(false)
        }
        onDismissEmailDialog={() => setEmailDialogOpen(false)}
        onDismissMicrophone={() => setMicrophoneDialog(null)}
        onDismissPrompt={() => cancelGuidancePrompt()}
        onEditorSelectionChange={handleEditorSelectionChange}
        onKeepStory={() => setEmailDialogOpen(true)}
        onOpenOriginalAudio={() => void loadStoryArtefacts("audio")}
        onOpenOriginalTranscript={() =>
          void loadStoryArtefacts("transcript")
        }
        onOpenStories={
          session &&
          phase !== "recording" &&
          phase !== "processing" &&
          !hasPendingSegment
            ? handleOpenStoryLibrary
            : undefined
        }
        onOpenStoryVisualisation={
          session &&
          phase !== "recording" &&
          phase !== "processing" &&
          !hasPendingSegment
            ? handleOpenStoryVisualisation
            : undefined
        }
        onOpenVersionHistory={
          storyEditConflict
            ? () => void handleReviewConflictVersions()
            : () => void loadStoryArtefacts("versions")
        }
        onRequestPrompt={() => void requestGuidancePrompt()}
        onRetryCapture={
          hasPendingSegment && pendingTranscriptRetryable
            ? () => void retryPendingTranscript()
            : undefined
        }
        onKeepAudioAndContinue={
          hasPendingSegment && canKeepPendingAudio
            ? () => void keepAudioAndContinue()
            : undefined
        }
        onReviewConflictVersions={
          storyEditConflict
            ? () => void handleReviewConflictVersions()
            : undefined
        }
        onDownloadRecordingBackup={
          hasEmergencyAudioBackup ? downloadEmergencyAudio : undefined
        }
        onStartRecording={() => {
          if (captureDisabled) {
            return;
          } else if (emergencyAudioBackupRef.current) {
            setCaptureMessage(
              "Download the unsaved recording backup before starting another recording.",
            );
          } else {
            setMicrophoneDialog("explanation");
            void probeTranscriptionReadiness().then(
              setTranscriptionReadiness,
            );
          }
        }}
        onStartNewStory={
          session && hasStarted ? () => void startNewStory() : undefined
        }
        onSyncNow={
          session &&
          persistenceState === "not-yet-synced" &&
          !hasEmergencyAudioBackup &&
          storyEditConflict === null
            ? () => void requestCloudSync()
            : undefined
        }
        onStopRecording={() => void stopActiveRecording(false)}
        persistenceState={
          hasEmergencyAudioBackup ? "sync-error" : persistenceState
        }
        phase={phase}
        readinessNotice={readinessNotice}
        recordingDurationSeconds={recordingDurationSeconds}
        startNewStoryDisabled={
          persistenceState !== "saved" ||
          phase === "recording" ||
          phase === "processing" ||
          hasPendingSegment ||
          hasEmergencyAudioBackup ||
          storyEditConflict !== null
        }
        />
      ) : null}
      {storySurface === "library" ? (
        <StoryLibraryDialog
          error={libraryError}
          items={libraryItems}
          loading={libraryLoading}
          onDismiss={() => setStorySurface(null)}
          onOpen={(storyId) => void handleOpenCloudStory(storyId)}
          onRetry={() => void loadStoryLibrary()}
        />
      ) : null}
      {storySurface === "visualisation" ? (
        <Suspense
          fallback={
            <main className="capture-layout">
              <p aria-live="polite" role="status">
                Opening your story visualisation…
              </p>
            </main>
          }
        >
          <StoryVisualisation
            error={libraryError}
            items={libraryItems}
            loading={libraryLoading}
            onDismiss={handleDismissStoryVisualisation}
            onOpen={(storyId) => void handleOpenCloudStory(storyId)}
            onRetry={() => void loadStoryLibrary()}
          />
        </Suspense>
      ) : null}
      {artefactsMode ? (
        <StoryArtefactsDialog
          audioItems={artefactAudioItems}
          mode={artefactsMode}
          onDismiss={handleDismissArtefacts}
          onPlayUncertainty={handlePlayUncertainty}
          onRestoreVersion={(versionId) =>
            void handleRestoreVersion(versionId)
          }
          transcriptItems={artefactTranscriptItems}
          versions={artefactVersionItems}
        />
      ) : null}
    </>
  );
}

export default App;
