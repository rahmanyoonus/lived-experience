export type Uuid = `${string}-${string}-${string}-${string}-${string}`;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export interface GuestStoryRecord {
  readonly client_story_id: Uuid;
  readonly guest_slot: "active";
  readonly title: string | null;
  readonly current_text: string;
  readonly current_version_id: Uuid | null;
  readonly revision: number;
  readonly captured_at: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly expires_at: number;
}

export type AudioSegmentStatus = "recording" | "finalised" | "failed";
export type TranscriptionDisposition = "pending" | "complete" | "skipped";

export interface AudioSegmentRecord {
  readonly client_segment_id: Uuid;
  readonly client_story_id: Uuid;
  /** One-based position of this explicit start-to-stop recording. */
  readonly sequence_number: number;
  readonly media_type: string;
  readonly byte_size: number;
  readonly duration_ms: number;
  readonly status: AudioSegmentStatus;
  /** Independent of whether the immutable audio itself is safely finalised. */
  readonly transcription_disposition: TranscriptionDisposition;
  readonly failure_code: string | null;
  readonly recorded_at: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface AudioChunkRecord {
  /** Deterministic local key; timeslice chunks are never uploaded independently. */
  readonly id: string;
  readonly client_story_id: Uuid;
  readonly client_segment_id: Uuid;
  /** One-based order in which MediaRecorder emitted this chunk. */
  readonly chunk_sequence_number: number;
  /** One-based completed MediaRecorder run within the logical segment. */
  readonly part_sequence_number: number;
  /** One-based MediaRecorder emission order within the standalone part. */
  readonly part_chunk_sequence_number: number;
  /** Logical audio offset at which this part begins. */
  readonly part_start_offset_ms: number;
  /** Elapsed time in this recorder run when the chunk was emitted. */
  readonly part_elapsed_ms: number;
  /** Set only on the final emitted chunk after the recorder is stopped. */
  readonly completed_part_duration_ms: number | null;
  readonly media_type: string;
  readonly byte_size: number;
  readonly blob: Blob;
  readonly created_at: number;
}

/** A safe provider/playback unit reconstructed from one completed recorder. */
export interface StandaloneAudioPart {
  /** Stable deterministic local key. */
  readonly id: string;
  readonly client_story_id: Uuid;
  readonly client_segment_id: Uuid;
  readonly part_sequence_number: number;
  readonly media_type: string;
  readonly byte_size: number;
  readonly duration_ms: number;
  readonly start_offset_ms: number;
  readonly blob: Blob;
}

export interface TranscriptUncertainty {
  readonly [key: string]: JsonValue;
}

export interface OriginalTranscriptRecord {
  readonly client_transcript_id: Uuid;
  readonly client_story_id: Uuid;
  readonly client_segment_id: Uuid;
  readonly transcript_text: string;
  readonly language_code: "en";
  readonly uncertainties: readonly TranscriptUncertainty[];
  readonly transcription_provider: string;
  readonly transcription_model: string;
  readonly transcript_sha256: string | null;
  readonly created_at: number;
}

/**
 * Durable proof that a segment's immutable transcript was inserted into the
 * editable story. The segment id is the idempotency key for the whole local
 * application transaction.
 */
export interface TranscriptApplicationRecord {
  readonly client_segment_id: Uuid;
  readonly client_story_id: Uuid;
  readonly client_transcript_id: Uuid;
  readonly client_version_id: Uuid;
  readonly applied_story_revision: number;
  readonly payload_generation: number;
  readonly created_at: number;
}

export interface StoryVersionRecord {
  readonly client_version_id: Uuid;
  readonly client_story_id: Uuid;
  readonly version_number: number;
  readonly story_text: string;
  readonly reason: string;
  readonly restored_from_version_id: Uuid | null;
  readonly content_sha256: string | null;
  readonly created_at: number;
}

export type MigrationOutboxState = "pending" | "in-flight" | "completed";

export interface MigrationOutboxRecord {
  readonly idempotency_key: Uuid;
  readonly client_story_id: Uuid;
  readonly state: MigrationOutboxState;
  /** Changes whenever any content-bearing local record changes. */
  readonly payload_generation: number;
  /** Latest generation durably acknowledged by the cloud. */
  readonly cloud_synced_generation: number;
  /** Cloud revision acknowledged for the latest synced local generation. */
  readonly last_acknowledged_cloud_revision: number | null;
  readonly last_acknowledged_cloud_version_id: Uuid | null;
  readonly attempted_generation: number | null;
  readonly attempt_count: number;
  readonly last_attempt_at: number | null;
  readonly last_failure_code: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface MigrationReceiptRecord {
  readonly id: Uuid;
  readonly owner_id: Uuid;
  readonly idempotency_key: Uuid;
  readonly guest_draft_id: Uuid;
  readonly client_story_id: Uuid;
  readonly story_id: Uuid;
  readonly payload_sha256: string | null;
  readonly migrated_generation: number;
  readonly created_at: number;
}

export interface MigrationAttempt {
  readonly idempotency_key: Uuid;
  readonly client_story_id: Uuid;
  readonly payload_generation: number;
  readonly attempt_count: number;
}

export interface CloudSyncAttempt {
  readonly owner_id: Uuid;
  readonly story_id: Uuid;
  readonly client_story_id: Uuid;
  readonly payload_generation: number;
  readonly attempt_count: number;
  readonly last_acknowledged_cloud_revision: number;
  readonly last_acknowledged_cloud_version_id: Uuid | null;
}

export interface RecoveredGuestDraft {
  readonly story: GuestStoryRecord;
  readonly audio_segments: readonly AudioSegmentRecord[];
  readonly original_transcripts: readonly OriginalTranscriptRecord[];
  readonly transcript_applications: readonly TranscriptApplicationRecord[];
  readonly story_versions: readonly StoryVersionRecord[];
  readonly migration_outbox: MigrationOutboxRecord;
  readonly migration_receipt: MigrationReceiptRecord | null;
  /**
   * True when the guest claim succeeded but newer local content still needs a
   * normal authenticated cloud save.
   */
  readonly has_local_changes_after_migration: boolean;
}

/** Resolves only after the IndexedDB transaction has committed. */
export interface LocalWriteAcknowledgement<T> {
  readonly persisted: true;
  readonly acknowledged_at: number;
  readonly value: T;
}

export type EnsureStoryInput =
  | {
      readonly kind: "text";
      readonly current_text: string;
    }
  | {
      readonly kind: "recording-start";
    };

export interface SaveTextInput {
  readonly current_text: string;
  readonly expected_revision?: number;
}

export interface CreateAudioSegmentInput {
  readonly media_type: string;
}

export interface AppendAudioChunkInput {
  readonly client_segment_id: Uuid;
  readonly chunk_sequence_number: number;
  readonly part_sequence_number?: number;
  readonly part_chunk_sequence_number?: number;
  readonly part_start_offset_ms?: number;
  readonly part_elapsed_ms?: number;
  readonly blob: Blob;
}

export interface FinaliseAudioPartInput {
  readonly client_segment_id: Uuid;
  readonly part_sequence_number: number;
  readonly duration_ms: number;
}

export interface FinaliseAudioSegmentInput {
  readonly client_segment_id: Uuid;
  readonly duration_ms: number;
}

export interface FailAudioSegmentInput {
  readonly client_segment_id: Uuid;
  /** A content-free machine code, not an exception message. */
  readonly failure_code: string;
}

export interface SkipAudioTranscriptionInput {
  readonly client_segment_id: Uuid;
}

export interface RecoveredInterruptedAudio {
  /** Null only when no independently recoverable audio part exists. */
  readonly segment: AudioSegmentRecord | null;
  readonly parts: readonly StandaloneAudioPart[];
  /** True when an unfinished final recorder run was made usable best-effort. */
  readonly tail_finalised: boolean;
  /** True when raw tail chunks remain locally but could not be made playable. */
  readonly unfinished_tail_preserved: boolean;
}

export interface SaveOriginalTranscriptInput {
  readonly client_segment_id: Uuid;
  readonly transcript_text: string;
  readonly uncertainties?: readonly TranscriptUncertainty[];
  readonly transcription_provider: string;
  readonly transcription_model: string;
  readonly transcript_sha256?: string | null;
}

export interface ApplyOriginalTranscriptInput
  extends SaveOriginalTranscriptInput {
  /** The complete editable story after this transcript has been inserted. */
  readonly current_text: string;
  /** Guards against overwriting typing that committed before this transaction. */
  readonly expected_revision?: number;
  readonly content_sha256?: string | null;
}

export interface AppliedOriginalTranscript {
  readonly application: TranscriptApplicationRecord;
  readonly original_transcript: OriginalTranscriptRecord;
  readonly story_version: StoryVersionRecord;
  readonly story: GuestStoryRecord;
}

export interface AppendStoryVersionInput {
  readonly reason: string;
  readonly content_sha256?: string | null;
}

export interface RestoreStoryVersionInput {
  readonly client_version_id: Uuid;
  readonly content_sha256?: string | null;
}

/**
 * Restores text whose source version is held outside this local database, such
 * as a version opened from the authenticated cloud history.
 */
export interface RestoreExternalStoryTextInput {
  readonly story_text: string;
  /** Guards against replacing local typing committed after the source opened. */
  readonly expected_revision?: number;
  readonly content_sha256?: string | null;
}

export type CloudStoryConflictSelection =
  | {
      readonly kind: "local-version";
      readonly client_version_id: Uuid;
    }
  | {
      readonly kind: "account-version";
      readonly story_text: string;
      readonly cloud_version_id: Uuid | null;
    };

/**
 * Records a deliberate conflict choice and advances the compare-and-swap base
 * in the same IndexedDB transaction. The cloud base can therefore never be
 * rebased without also creating a new recoverable current version.
 */
export interface ResolveCloudStoryConflictInput {
  readonly client_story_id: Uuid;
  readonly story_id: Uuid;
  /** Guards against replacing typing committed after Version history opened. */
  readonly expected_story_revision: number;
  /** The durable base that produced the conflict. */
  readonly expected_acknowledged_cloud_revision: number;
  /** The incumbent cloud base returned with the conflict. */
  readonly incumbent_cloud_revision: number;
  readonly incumbent_cloud_version_id: Uuid | null;
  readonly selection: CloudStoryConflictSelection;
}

export interface RestoredStoryText {
  readonly story: GuestStoryRecord;
  readonly version: StoryVersionRecord;
}

export interface FailMigrationInput {
  readonly idempotency_key: Uuid;
  /** A content-free machine code, not an exception message. */
  readonly failure_code: string;
}

export interface DiscardGuestDraftInput {
  /** Guards against a stale screen deleting a newer active draft. */
  readonly client_story_id: Uuid;
}

export interface ClearCloudAcknowledgedStoryInput {
  /** Guards against a stale screen clearing a newer active local mirror. */
  readonly client_story_id: Uuid;
}

export interface MarkMigrationInput {
  readonly owner_id: Uuid;
  readonly story_id: Uuid;
  readonly idempotency_key: Uuid;
  readonly payload_generation: number;
  readonly cloud_revision: number;
  readonly cloud_version_id: Uuid | null;
  readonly payload_sha256?: string | null;
}

export interface AcknowledgeCloudSyncInput {
  readonly client_story_id: Uuid;
  readonly story_id: Uuid;
  readonly payload_generation: number;
  readonly cloud_revision: number;
  readonly cloud_version_id: Uuid | null;
}

export interface AdoptCloudStoryInput {
  readonly owner_id: Uuid;
  readonly story_id: Uuid;
  readonly client_story_id: Uuid;
  readonly title: string | null;
  readonly current_text: string;
  readonly cloud_revision: number;
  readonly cloud_version_id: Uuid | null;
  readonly captured_at: number;
}

export interface ReplaceActiveWithCloudStoryInput extends AdoptCloudStoryInput {
  /** Guards against replacing a newer active draft from a stale screen. */
  readonly expected_current_client_story_id: Uuid;
}

export interface GuestPersistenceOptions {
  readonly databaseName?: string;
  readonly now?: () => Date;
}

export interface GuestPersistence {
  /**
   * Proves that IndexedDB can commit, read and remove a content-free record.
   * This does not create a story or retain any user content.
   */
  probeReadiness(): Promise<LocalWriteAcknowledgement<true>>;
  ensureStory(
    input: EnsureStoryInput,
  ): Promise<LocalWriteAcknowledgement<GuestStoryRecord> | null>;
  saveText(
    input: SaveTextInput,
  ): Promise<LocalWriteAcknowledgement<GuestStoryRecord> | null>;
  createAudioSegment(
    input: CreateAudioSegmentInput,
  ): Promise<LocalWriteAcknowledgement<AudioSegmentRecord>>;
  appendAudioChunk(
    input: AppendAudioChunkInput,
  ): Promise<LocalWriteAcknowledgement<AudioChunkRecord>>;
  readAudioChunks(
    client_segment_id: Uuid,
  ): Promise<readonly AudioChunkRecord[]>;
  finaliseAudioPart(
    input: FinaliseAudioPartInput,
  ): Promise<LocalWriteAcknowledgement<StandaloneAudioPart>>;
  /**
   * Returns independently playable completed parts only. A final unfinished
   * tail is retained but omitted unless recovery can finalise it best-effort.
   */
  readAudioParts(
    client_segment_id: Uuid,
  ): Promise<readonly StandaloneAudioPart[]>;
  finaliseAudioSegment(
    input: FinaliseAudioSegmentInput,
  ): Promise<LocalWriteAcknowledgement<AudioSegmentRecord>>;
  failAudioSegment(
    input: FailAudioSegmentInput,
  ): Promise<LocalWriteAcknowledgement<AudioSegmentRecord>>;
  skipAudioTranscription(
    input: SkipAudioTranscriptionInput,
  ): Promise<LocalWriteAcknowledgement<AudioSegmentRecord>>;
  recoverInterruptedAudioSegment(
    client_segment_id: Uuid,
  ): Promise<LocalWriteAcknowledgement<RecoveredInterruptedAudio>>;
  saveOriginalTranscript(
    input: SaveOriginalTranscriptInput,
  ): Promise<LocalWriteAcknowledgement<OriginalTranscriptRecord>>;
  applyOriginalTranscript(
    input: ApplyOriginalTranscriptInput,
  ): Promise<LocalWriteAcknowledgement<AppliedOriginalTranscript>>;
  appendStoryVersion(
    input: AppendStoryVersionInput,
  ): Promise<LocalWriteAcknowledgement<StoryVersionRecord>>;
  ensureCurrentStoryVersion(
    input: AppendStoryVersionInput,
  ): Promise<LocalWriteAcknowledgement<StoryVersionRecord>>;
  restoreStoryVersion(
    input: RestoreStoryVersionInput,
  ): Promise<LocalWriteAcknowledgement<RestoredStoryText>>;
  restoreExternalStoryText(
    input: RestoreExternalStoryTextInput,
  ): Promise<LocalWriteAcknowledgement<RestoredStoryText>>;
  resolveCloudStoryConflict(
    input: ResolveCloudStoryConflictInput,
  ): Promise<LocalWriteAcknowledgement<RestoredStoryText>>;
  recoverGuestDraft(): Promise<RecoveredGuestDraft | null>;
  purgeExpiredGuestDrafts(): Promise<LocalWriteAcknowledgement<number>>;
  discardGuestDraft(
    input: DiscardGuestDraftInput,
  ): Promise<LocalWriteAcknowledgement<boolean>>;
  /**
   * Clears the one local mirror only after every local payload generation has
   * been acknowledged by the cloud and no recording still needs attention.
   */
  clearCloudAcknowledgedStory(
    input: ClearCloudAcknowledgedStoryInput,
  ): Promise<LocalWriteAcknowledgement<boolean>>;
  adoptCloudStory(
    input: AdoptCloudStoryInput,
  ): Promise<LocalWriteAcknowledgement<GuestStoryRecord>>;
  replaceActiveWithCloudStory(
    input: ReplaceActiveWithCloudStoryInput,
  ): Promise<LocalWriteAcknowledgement<GuestStoryRecord>>;
  getMigrationOutbox(): Promise<MigrationOutboxRecord | null>;
  beginMigration(): Promise<LocalWriteAcknowledgement<MigrationAttempt>>;
  beginCloudSync(): Promise<LocalWriteAcknowledgement<CloudSyncAttempt>>;
  failMigration(
    input: FailMigrationInput,
  ): Promise<LocalWriteAcknowledgement<MigrationOutboxRecord>>;
  markMigration(
    input: MarkMigrationInput,
  ): Promise<LocalWriteAcknowledgement<MigrationReceiptRecord>>;
  acknowledgeCloudSync(
    input: AcknowledgeCloudSyncInput,
  ): Promise<LocalWriteAcknowledgement<MigrationOutboxRecord>>;
  close(): void;
}
