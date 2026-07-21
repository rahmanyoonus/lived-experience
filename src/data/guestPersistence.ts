import Dexie, { type Table } from "dexie";

import {
  AudioChunkSequenceError,
  ImmutableRecordError,
  InvalidPersistenceInputError,
  MigrationConflictError,
  PersistenceInvariantError,
  PersistenceRecordNotFoundError,
  StaleStoryRevisionError,
} from "./errors";
import type {
  AcknowledgeCloudSyncInput,
  AdoptCloudStoryInput,
  AppliedOriginalTranscript,
  ApplyOriginalTranscriptInput,
  AppendAudioChunkInput,
  AppendStoryVersionInput,
  AudioChunkRecord,
  AudioSegmentRecord,
  ClearCloudAcknowledgedStoryInput,
  CloudSyncAttempt,
  CreateAudioSegmentInput,
  DiscardGuestDraftInput,
  EnsureStoryInput,
  FailAudioSegmentInput,
  FailMigrationInput,
  FinaliseAudioPartInput,
  FinaliseAudioSegmentInput,
  GuestPersistence,
  GuestPersistenceOptions,
  GuestStoryRecord,
  LocalWriteAcknowledgement,
  MarkMigrationInput,
  MigrationAttempt,
  MigrationOutboxRecord,
  MigrationReceiptRecord,
  OriginalTranscriptRecord,
  RecoveredGuestDraft,
  RecoveredInterruptedAudio,
  ReplaceActiveWithCloudStoryInput,
  ResolveCloudStoryConflictInput,
  RestoredStoryText,
  RestoreExternalStoryTextInput,
  RestoreStoryVersionInput,
  SaveOriginalTranscriptInput,
  SaveTextInput,
  SkipAudioTranscriptionInput,
  StandaloneAudioPart,
  StoryVersionRecord,
  TranscriptApplicationRecord,
  TranscriptUncertainty,
  Uuid,
} from "./types";

const DEFAULT_DATABASE_NAME = "lived-experience-guest-v1";
const ACTIVE_GUEST_SLOT = "active" as const;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_SEGMENT_DURATION_MS = 30 * 60 * 1_000;
const MAX_STANDALONE_AUDIO_PART_DURATION_MS = 4 * 60 * 1_000;
const AUDIO_MEDIA_TYPE = /^audio\/[a-z0-9!#$&^_.+-]+(?:\s*;.*)?$/i;
const MACHINE_CODE = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION_REASON = /^[a-z][a-z0-9-]{0,31}$/;
const SHA_256 = /^[a-f0-9]{64}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ReadinessProbeRecord {
  readonly id: "device";
  readonly checked_at: number;
}

class GuestDatabase extends Dexie {
  stories!: Table<GuestStoryRecord, Uuid>;
  audioSegments!: Table<AudioSegmentRecord, Uuid>;
  audioChunks!: Table<AudioChunkRecord, string>;
  originalTranscripts!: Table<OriginalTranscriptRecord, Uuid>;
  transcriptApplications!: Table<TranscriptApplicationRecord, Uuid>;
  storyVersions!: Table<StoryVersionRecord, Uuid>;
  migrationOutbox!: Table<MigrationOutboxRecord, Uuid>;
  migrationReceipts!: Table<MigrationReceiptRecord, Uuid>;
  readinessProbes!: Table<ReadinessProbeRecord, "device">;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      stories: "&client_story_id,&guest_slot,updated_at,expires_at",
      audioSegments:
        "&client_segment_id,client_story_id,[client_story_id+sequence_number],status,created_at",
      audioChunks:
        "&id,client_story_id,client_segment_id,[client_segment_id+chunk_sequence_number],created_at",
      originalTranscripts:
        "&client_transcript_id,&client_segment_id,client_story_id,created_at",
      storyVersions:
        "&client_version_id,client_story_id,[client_story_id+version_number],created_at",
      migrationOutbox:
        "&idempotency_key,&client_story_id,state,updated_at",
      migrationReceipts:
        "&id,&idempotency_key,&guest_draft_id,client_story_id,owner_id,created_at",
    });
    this.version(2).stores({
      transcriptApplications:
        "&client_segment_id,client_story_id,&client_transcript_id,&client_version_id,created_at",
    });
    this.version(3).stores({
      audioChunks:
        "&id,client_story_id,client_segment_id,[client_segment_id+chunk_sequence_number],[client_segment_id+part_sequence_number],created_at",
    });
    this.version(4).stores({});
    this.version(5).stores({
      readinessProbes: "&id,checked_at",
    });
  }
}

function createUuid(): Uuid {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new PersistenceInvariantError(
      "Secure browser UUID generation is unavailable.",
    );
  }

  return globalThis.crypto.randomUUID();
}

function assertUuid(value: string, field: string): asserts value is Uuid {
  if (!UUID.test(value)) {
    throw new InvalidPersistenceInputError(`${field} must be a UUID.`);
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidPersistenceInputError(
      `${field} must be a non-negative safe integer.`,
    );
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvalidPersistenceInputError(
      `${field} must be a positive safe integer.`,
    );
  }
}

function normaliseAudioMediaType(mediaType: string): string {
  const normalised = mediaType.trim().toLowerCase();
  if (!AUDIO_MEDIA_TYPE.test(normalised)) {
    throw new InvalidPersistenceInputError(
      "media_type must be a valid audio MIME type.",
    );
  }
  return normalised;
}

function audioBaseMediaType(mediaType: string): string {
  return normaliseAudioMediaType(mediaType).split(";", 1)[0]!.trim();
}

function audioMediaTypesAreEquivalent(left: string, right: string): boolean {
  return audioBaseMediaType(left) === audioBaseMediaType(right);
}

function isBlob(value: unknown): value is Blob {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const possibleBlob = value as Partial<Blob>;
  return (
    typeof possibleBlob.size === "number" &&
    typeof possibleBlob.type === "string" &&
    typeof possibleBlob.slice === "function"
  );
}

function standalonePart(
  chunks: readonly AudioChunkRecord[],
  durationMs: number,
): StandaloneAudioPart {
  const first = chunks[0];
  if (!first || chunks.length === 0) {
    throw new PersistenceInvariantError("Audio part is empty.");
  }
  for (const [index, chunk] of chunks.entries()) {
    if (
      chunk.client_segment_id !== first.client_segment_id ||
      chunk.client_story_id !== first.client_story_id ||
      chunk.part_sequence_number !== first.part_sequence_number ||
      chunk.part_chunk_sequence_number !== index + 1 ||
      chunk.part_start_offset_ms !== first.part_start_offset_ms ||
      !audioMediaTypesAreEquivalent(chunk.media_type, first.media_type)
    ) {
      throw new PersistenceInvariantError(
        "Audio part chunks do not form one completed recorder output.",
      );
    }
  }
  const blob = new Blob(
    chunks.map((chunk) => chunk.blob),
    { type: first.media_type },
  );
  return {
    id: `${first.client_segment_id}:${first.part_sequence_number}`,
    client_story_id: first.client_story_id,
    client_segment_id: first.client_segment_id,
    part_sequence_number: first.part_sequence_number,
    media_type: first.media_type,
    byte_size: chunks.reduce((total, chunk) => total + chunk.byte_size, 0),
    duration_ms: durationMs,
    start_offset_ms: first.part_start_offset_ms,
    blob,
  };
}

function assertMachineCode(value: string, field: string): void {
  if (!MACHINE_CODE.test(value)) {
    throw new InvalidPersistenceInputError(
      `${field} must be a content-free lower-case machine code.`,
    );
  }
}

function assertVersionReason(value: string): void {
  if (!VERSION_REASON.test(value)) {
    throw new InvalidPersistenceInputError(
      "reason must be a lower-case version-history code.",
    );
  }
}

function normaliseSha256(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!SHA_256.test(value)) {
    throw new InvalidPersistenceInputError(
      "A SHA-256 digest must contain 64 hexadecimal characters.",
    );
  }
  return value.toLowerCase();
}

function uncertaintiesMatch(
  first: readonly TranscriptUncertainty[],
  second: readonly TranscriptUncertainty[],
): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

interface NormalisedTranscriptInput {
  readonly transcript_text: string;
  readonly uncertainties: readonly TranscriptUncertainty[];
  readonly transcription_provider: string;
  readonly transcription_model: string;
  readonly transcript_sha256: string | null;
}

function normaliseTranscriptInput(
  input: SaveOriginalTranscriptInput,
): NormalisedTranscriptInput {
  assertUuid(input.client_segment_id, "client_segment_id");
  const transcriptionProvider = input.transcription_provider.trim();
  if (transcriptionProvider.length === 0) {
    throw new InvalidPersistenceInputError(
      "transcription_provider must be present.",
    );
  }
  const transcriptionModel = input.transcription_model.trim();
  if (transcriptionModel.length === 0) {
    throw new InvalidPersistenceInputError(
      "transcription_model must be present.",
    );
  }

  return {
    transcript_text: input.transcript_text,
    uncertainties: input.uncertainties ?? [],
    transcription_provider: transcriptionProvider,
    transcription_model: transcriptionModel,
    transcript_sha256: normaliseSha256(input.transcript_sha256),
  };
}

function originalTranscriptMatches(
  existing: OriginalTranscriptRecord,
  input: NormalisedTranscriptInput,
): boolean {
  return (
    existing.transcript_text === input.transcript_text &&
    existing.transcription_provider === input.transcription_provider &&
    existing.transcription_model === input.transcription_model &&
    existing.transcript_sha256 === input.transcript_sha256 &&
    uncertaintiesMatch(existing.uncertainties, input.uncertainties)
  );
}

function validateAdoptCloudStoryInput(input: AdoptCloudStoryInput): void {
  assertUuid(input.owner_id, "owner_id");
  assertUuid(input.story_id, "story_id");
  assertUuid(input.client_story_id, "client_story_id");
  assertNonNegativeInteger(input.cloud_revision, "cloud_revision");
  if (input.cloud_version_id !== null) {
    assertUuid(input.cloud_version_id, "cloud_version_id");
  }
  assertNonNegativeInteger(input.captured_at, "captured_at");
  if (input.title !== null && input.title.trim().length === 0) {
    throw new InvalidPersistenceInputError(
      "title must be null or contain visible text.",
    );
  }
}

class DexieGuestPersistence implements GuestPersistence {
  private readonly database: GuestDatabase;
  private readonly now: () => Date;

  constructor(options: GuestPersistenceOptions = {}) {
    this.database = new GuestDatabase(
      options.databaseName ?? DEFAULT_DATABASE_NAME,
    );
    this.now = options.now ?? (() => new Date());
  }

  private timestamp(): number {
    const timestamp = this.now().getTime();
    if (!Number.isFinite(timestamp)) {
      throw new PersistenceInvariantError(
        "The persistence clock returned an invalid timestamp.",
      );
    }
    return timestamp;
  }

  private acknowledgement<T>(value: T): LocalWriteAcknowledgement<T> {
    return {
      persisted: true,
      acknowledged_at: this.timestamp(),
      value,
    };
  }

  private async activeStory(): Promise<GuestStoryRecord | undefined> {
    return this.database.stories
      .where("guest_slot")
      .equals(ACTIVE_GUEST_SLOT)
      .first();
  }

  async probeReadiness(): Promise<LocalWriteAcknowledgement<true>> {
    const checkedAt = this.timestamp();
    await this.database.transaction(
      "rw",
      this.database.readinessProbes,
      async () => {
        await this.database.readinessProbes.put({
          id: "device",
          checked_at: checkedAt,
        });
        const persisted = await this.database.readinessProbes.get("device");
        if (persisted?.checked_at !== checkedAt) {
          throw new PersistenceInvariantError(
            "The device readiness write could not be verified.",
          );
        }
        await this.database.readinessProbes.delete("device");
      },
    );
    return this.acknowledgement(true);
  }

  private async createStory(
    currentText: string,
    timestamp: number,
  ): Promise<GuestStoryRecord> {
    const story: GuestStoryRecord = {
      client_story_id: createUuid(),
      guest_slot: ACTIVE_GUEST_SLOT,
      title: null,
      current_text: currentText,
      current_version_id: null,
      revision: currentText.length > 0 ? 1 : 0,
      captured_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
      expires_at: timestamp + THIRTY_DAYS_MS,
    };
    const outbox: MigrationOutboxRecord = {
      idempotency_key: createUuid(),
      client_story_id: story.client_story_id,
      state: "pending",
      payload_generation: 1,
      cloud_synced_generation: 0,
      last_acknowledged_cloud_revision: null,
      last_acknowledged_cloud_version_id: null,
      attempted_generation: null,
      attempt_count: 0,
      last_attempt_at: null,
      last_failure_code: null,
      created_at: timestamp,
      updated_at: timestamp,
    };

    await this.database.stories.add(story);
    await this.database.migrationOutbox.add(outbox);
    return story;
  }

  private async createAdoptedCloudStory(
    input: AdoptCloudStoryInput,
    timestamp: number,
  ): Promise<GuestStoryRecord> {
    const adopted: GuestStoryRecord = {
      client_story_id: input.client_story_id,
      guest_slot: ACTIVE_GUEST_SLOT,
      title: input.title,
      current_text: input.current_text,
      current_version_id: null,
      revision: input.current_text.length > 0 ? 1 : 0,
      captured_at: input.captured_at,
      created_at: timestamp,
      updated_at: timestamp,
      expires_at: timestamp + THIRTY_DAYS_MS,
    };
    const idempotencyKey = createUuid();
    const outbox: MigrationOutboxRecord = {
      idempotency_key: idempotencyKey,
      client_story_id: input.client_story_id,
      state: "completed",
      payload_generation: 1,
      cloud_synced_generation: 1,
      last_acknowledged_cloud_revision: input.cloud_revision,
      last_acknowledged_cloud_version_id: input.cloud_version_id,
      attempted_generation: 1,
      attempt_count: 0,
      last_attempt_at: null,
      last_failure_code: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    const receipt: MigrationReceiptRecord = {
      id: createUuid(),
      owner_id: input.owner_id,
      idempotency_key: idempotencyKey,
      guest_draft_id: input.client_story_id,
      client_story_id: input.client_story_id,
      story_id: input.story_id,
      payload_sha256: null,
      migrated_generation: 1,
      created_at: timestamp,
    };
    await this.database.stories.add(adopted);
    await this.database.migrationOutbox.add(outbox);
    await this.database.migrationReceipts.add(receipt);
    return adopted;
  }

  private async refreshStoryExpiry(
    story: GuestStoryRecord,
    timestamp: number,
  ): Promise<GuestStoryRecord> {
    const refreshed: GuestStoryRecord = {
      ...story,
      updated_at: timestamp,
      expires_at: timestamp + THIRTY_DAYS_MS,
    };
    await this.database.stories.put(refreshed);
    return refreshed;
  }

  private async advanceOutbox(
    clientStoryId: Uuid,
    timestamp: number,
  ): Promise<MigrationOutboxRecord> {
    const outbox = await this.database.migrationOutbox
      .where("client_story_id")
      .equals(clientStoryId)
      .first();
    if (!outbox) {
      throw new PersistenceRecordNotFoundError("Migration outbox");
    }

    const advanced: MigrationOutboxRecord = {
      ...outbox,
      state: "pending",
      payload_generation: outbox.payload_generation + 1,
      updated_at: timestamp,
    };
    await this.database.migrationOutbox.put(advanced);
    return advanced;
  }

  async ensureStory(
    input: EnsureStoryInput,
  ): Promise<LocalWriteAcknowledgement<GuestStoryRecord> | null> {
    if (input.kind === "text" && input.current_text.length === 0) {
      return null;
    }

    const story = await this.database.transaction(
      "rw",
      this.database.stories,
      this.database.migrationOutbox,
      async () => {
        const existing = await this.activeStory();
        if (existing) {
          return this.refreshStoryExpiry(existing, this.timestamp());
        }
        return this.createStory(
          input.kind === "text" ? input.current_text : "",
          this.timestamp(),
        );
      },
    );

    return this.acknowledgement(story);
  }

  async saveText(
    input: SaveTextInput,
  ): Promise<LocalWriteAcknowledgement<GuestStoryRecord> | null> {
    assertNonNegativeInteger(input.expected_revision ?? 0, "expected_revision");

    const story = await this.database.transaction(
      "rw",
      this.database.stories,
      this.database.migrationOutbox,
      async () => {
        const existing = await this.activeStory();
        if (!existing) {
          if (input.current_text.length === 0) {
            return null;
          }
          if (
            input.expected_revision !== undefined &&
            input.expected_revision !== 0
          ) {
            throw new StaleStoryRevisionError(input.expected_revision, 0);
          }
          return this.createStory(input.current_text, this.timestamp());
        }

        if (
          input.expected_revision !== undefined &&
          input.expected_revision !== existing.revision
        ) {
          throw new StaleStoryRevisionError(
            input.expected_revision,
            existing.revision,
          );
        }

        const timestamp = this.timestamp();
        const changed = input.current_text !== existing.current_text;
        const saved: GuestStoryRecord = {
          ...existing,
          current_text: input.current_text,
          revision: changed ? existing.revision + 1 : existing.revision,
          updated_at: timestamp,
          expires_at: timestamp + THIRTY_DAYS_MS,
        };
        await this.database.stories.put(saved);
        if (changed) {
          await this.advanceOutbox(saved.client_story_id, timestamp);
        }
        return saved;
      },
    );

    return story === null ? null : this.acknowledgement(story);
  }

  async createAudioSegment(
    input: CreateAudioSegmentInput,
  ): Promise<LocalWriteAcknowledgement<AudioSegmentRecord>> {
    const mediaType = normaliseAudioMediaType(input.media_type);
    const segment = await this.database.transaction(
      "rw",
      this.database.stories,
      this.database.audioSegments,
      this.database.migrationOutbox,
      async () => {
        const timestamp = this.timestamp();
        let story = await this.activeStory();
        story ??= await this.createStory("", timestamp);

        const lastSegment = await this.database.audioSegments
          .where("[client_story_id+sequence_number]")
          .between(
            [story.client_story_id, Dexie.minKey],
            [story.client_story_id, Dexie.maxKey],
          )
          .last();
        const created: AudioSegmentRecord = {
          client_segment_id: createUuid(),
          client_story_id: story.client_story_id,
          sequence_number: (lastSegment?.sequence_number ?? 0) + 1,
          media_type: mediaType,
          byte_size: 0,
          duration_ms: 0,
          status: "recording",
          transcription_disposition: "pending",
          failure_code: null,
          recorded_at: timestamp,
          created_at: timestamp,
          updated_at: timestamp,
        };
        await this.database.audioSegments.add(created);
        await this.refreshStoryExpiry(story, timestamp);
        await this.advanceOutbox(story.client_story_id, timestamp);
        return created;
      },
    );

    return this.acknowledgement(segment);
  }

  async appendAudioChunk(
    input: AppendAudioChunkInput,
  ): Promise<LocalWriteAcknowledgement<AudioChunkRecord>> {
    assertUuid(input.client_segment_id, "client_segment_id");
    assertPositiveInteger(input.chunk_sequence_number, "chunk_sequence_number");
    const partSequenceNumber = input.part_sequence_number ?? 1;
    const partChunkSequenceNumber =
      input.part_chunk_sequence_number ?? input.chunk_sequence_number;
    const partStartOffsetMs = input.part_start_offset_ms ?? 0;
    const partElapsedMs = input.part_elapsed_ms ?? 1;
    assertPositiveInteger(partSequenceNumber, "part_sequence_number");
    assertPositiveInteger(
      partChunkSequenceNumber,
      "part_chunk_sequence_number",
    );
    assertNonNegativeInteger(
      partStartOffsetMs,
      "part_start_offset_ms",
    );
    assertPositiveInteger(partElapsedMs, "part_elapsed_ms");
    if (!isBlob(input.blob) || input.blob.size < 1) {
      throw new InvalidPersistenceInputError(
        "Audio chunks must be non-empty Blob values.",
      );
    }

    const chunk = await this.database.transaction(
      "rw",
      this.database.stories,
      this.database.audioSegments,
      this.database.audioChunks,
      this.database.migrationOutbox,
      async () => {
        const segment = await this.database.audioSegments.get(
          input.client_segment_id,
        );
        if (!segment) {
          throw new PersistenceRecordNotFoundError("Audio segment");
        }
        if (segment.status !== "recording") {
          throw new ImmutableRecordError("Finalised audio segment");
        }

        const chunkMediaType = normaliseAudioMediaType(
          input.blob.type || segment.media_type,
        );
        if (!audioMediaTypesAreEquivalent(chunkMediaType, segment.media_type)) {
          throw new InvalidPersistenceInputError(
            "Audio chunk media_type must match its segment.",
          );
        }

        const lastChunk = await this.database.audioChunks
          .where("[client_segment_id+chunk_sequence_number]")
          .between(
            [segment.client_segment_id, Dexie.minKey],
            [segment.client_segment_id, Dexie.maxKey],
          )
          .last();
        const expectedSequence =
          (lastChunk?.chunk_sequence_number ?? 0) + 1;
        if (input.chunk_sequence_number !== expectedSequence) {
          throw new AudioChunkSequenceError(
            expectedSequence,
            input.chunk_sequence_number,
          );
        }

        const priorPartChunks = await this.database.audioChunks
          .where("[client_segment_id+part_sequence_number]")
          .equals([
            segment.client_segment_id,
            partSequenceNumber,
          ])
          .sortBy("part_chunk_sequence_number");
        const expectedPartSequence =
          (priorPartChunks.at(-1)?.part_chunk_sequence_number ?? 0) + 1;
        if (partChunkSequenceNumber !== expectedPartSequence) {
          throw new AudioChunkSequenceError(
            expectedPartSequence,
            partChunkSequenceNumber,
          );
        }
        if (
          priorPartChunks.some(
            (chunk) => chunk.completed_part_duration_ms !== null,
          )
        ) {
          throw new ImmutableRecordError("Finalised audio part");
        }
        if (
          priorPartChunks.some(
            (chunk) =>
              chunk.part_start_offset_ms !== partStartOffsetMs,
          )
        ) {
          throw new InvalidPersistenceInputError(
            "Audio chunks in one part must share a start offset.",
          );
        }
        if (partSequenceNumber > 1 && priorPartChunks.length === 0) {
          const previousPartChunks = await this.database.audioChunks
            .where("[client_segment_id+part_sequence_number]")
            .equals([
              segment.client_segment_id,
              partSequenceNumber - 1,
            ])
            .sortBy("part_chunk_sequence_number");
          const previousPart = previousPartChunks.at(-1);
          if (!previousPart?.completed_part_duration_ms) {
            throw new InvalidPersistenceInputError(
              "A new audio part cannot begin before the previous part is finalised.",
            );
          }
          const expectedStartOffset =
            previousPart.part_start_offset_ms +
            previousPart.completed_part_duration_ms;
          if (partStartOffsetMs !== expectedStartOffset) {
            throw new InvalidPersistenceInputError(
              "Audio part start offsets must be contiguous.",
            );
          }
        }

        const timestamp = this.timestamp();
        const stored: AudioChunkRecord = {
          id: `${segment.client_segment_id}:${input.chunk_sequence_number}`,
          client_story_id: segment.client_story_id,
          client_segment_id: segment.client_segment_id,
          chunk_sequence_number: input.chunk_sequence_number,
          part_sequence_number: partSequenceNumber,
          part_chunk_sequence_number: partChunkSequenceNumber,
          part_start_offset_ms: partStartOffsetMs,
          part_elapsed_ms: partElapsedMs,
          completed_part_duration_ms: null,
          media_type: chunkMediaType,
          byte_size: input.blob.size,
          blob: input.blob.slice(0, input.blob.size, chunkMediaType),
          created_at: timestamp,
        };
        await this.database.audioChunks.add(stored);

        const story = await this.database.stories.get(segment.client_story_id);
        if (!story) {
          throw new PersistenceRecordNotFoundError("Guest story");
        }
        await this.refreshStoryExpiry(story, timestamp);
        await this.advanceOutbox(story.client_story_id, timestamp);
        return stored;
      },
    );

    return this.acknowledgement(chunk);
  }

  async readAudioChunks(
    clientSegmentId: Uuid,
  ): Promise<readonly AudioChunkRecord[]> {
    assertUuid(clientSegmentId, "client_segment_id");
    const segment = await this.database.audioSegments.get(clientSegmentId);
    if (!segment) {
      throw new PersistenceRecordNotFoundError("Audio segment");
    }
    return this.database.audioChunks
      .where("client_segment_id")
      .equals(clientSegmentId)
      .sortBy("chunk_sequence_number");
  }

  async finaliseAudioPart(
    input: FinaliseAudioPartInput,
  ): Promise<LocalWriteAcknowledgement<StandaloneAudioPart>> {
    assertUuid(input.client_segment_id, "client_segment_id");
    assertPositiveInteger(input.part_sequence_number, "part_sequence_number");
    assertPositiveInteger(input.duration_ms, "duration_ms");

    const part = await this.database.transaction(
      "rw",
      this.database.audioSegments,
      this.database.audioChunks,
      this.database.stories,
      this.database.migrationOutbox,
      async () => {
        const segment = await this.database.audioSegments.get(
          input.client_segment_id,
        );
        if (!segment) {
          throw new PersistenceRecordNotFoundError("Audio segment");
        }
        if (segment.status !== "recording") {
          throw new ImmutableRecordError("Finalised audio segment");
        }
        const chunks = await this.database.audioChunks
          .where("[client_segment_id+part_sequence_number]")
          .equals([
            input.client_segment_id,
            input.part_sequence_number,
          ])
          .sortBy("part_chunk_sequence_number");
        if (chunks.length === 0) {
          throw new PersistenceInvariantError(
            "An audio part cannot be finalised before a chunk is stored.",
          );
        }
        const existingDuration = chunks.at(-1)?.completed_part_duration_ms;
        if (existingDuration !== null && existingDuration !== undefined) {
          if (existingDuration !== input.duration_ms) {
            throw new ImmutableRecordError("Finalised audio part");
          }
          return standalonePart(chunks, existingDuration);
        }
        const last = chunks.at(-1);
        if (!last) {
          throw new PersistenceInvariantError("Audio part is empty.");
        }
        await this.database.audioChunks.update(last.id, {
          completed_part_duration_ms: input.duration_ms,
        });
        const finalChunks = chunks.map((chunk, index) =>
          index === chunks.length - 1
            ? { ...chunk, completed_part_duration_ms: input.duration_ms }
            : chunk,
        );
        const story = await this.database.stories.get(segment.client_story_id);
        if (!story) {
          throw new PersistenceRecordNotFoundError("Guest story");
        }
        const timestamp = this.timestamp();
        await this.refreshStoryExpiry(story, timestamp);
        await this.advanceOutbox(story.client_story_id, timestamp);
        return standalonePart(finalChunks, input.duration_ms);
      },
    );
    return this.acknowledgement(part);
  }

  async readAudioParts(
    clientSegmentId: Uuid,
  ): Promise<readonly StandaloneAudioPart[]> {
    const chunks = await this.readAudioChunks(clientSegmentId);
    const grouped = new Map<number, AudioChunkRecord[]>();
    for (const chunk of chunks) {
      const group = grouped.get(chunk.part_sequence_number) ?? [];
      group.push(chunk);
      grouped.set(chunk.part_sequence_number, group);
    }
    const parts: StandaloneAudioPart[] = [];
    for (let sequenceNumber = 1; sequenceNumber <= grouped.size; sequenceNumber += 1) {
      const partChunks = grouped.get(sequenceNumber);
      if (!partChunks || partChunks.length === 0) {
        throw new PersistenceInvariantError(
          "Audio parts must be stored in sequence.",
        );
      }
      const durationMs = partChunks.at(-1)?.completed_part_duration_ms;
      if (durationMs === null || durationMs === undefined) {
        if (sequenceNumber === grouped.size && parts.length > 0) {
          // Interrupted final timeslices remain retained locally, but are not
          // represented as independently playable media unless recovery can
          // durably finalise that recorder run.
          break;
        }
        throw new PersistenceInvariantError(
          "An unfinished MediaRecorder part is not a standalone audio file.",
        );
      }
      parts.push(standalonePart(partChunks, durationMs));
    }
    return parts;
  }

  async recoverInterruptedAudioSegment(
    clientSegmentId: Uuid,
  ): Promise<LocalWriteAcknowledgement<RecoveredInterruptedAudio>> {
    assertUuid(clientSegmentId, "client_segment_id");
    const recovered = await this.database.transaction(
      "rw",
      this.database.stories,
      this.database.audioSegments,
      this.database.audioChunks,
      this.database.migrationOutbox,
      async (): Promise<RecoveredInterruptedAudio> => {
        const existing = await this.database.audioSegments.get(clientSegmentId);
        if (!existing) {
          throw new PersistenceRecordNotFoundError("Audio segment");
        }
        const chunks = await this.database.audioChunks
          .where("client_segment_id")
          .equals(clientSegmentId)
          .sortBy("chunk_sequence_number");
        if (chunks.length === 0) {
          return {
            segment: null,
            parts: [],
            tail_finalised: false,
            unfinished_tail_preserved: false,
          };
        }

        const grouped = new Map<number, AudioChunkRecord[]>();
        for (const chunk of chunks) {
          const group = grouped.get(chunk.part_sequence_number) ?? [];
          group.push(chunk);
          grouped.set(chunk.part_sequence_number, group);
        }
        const parts: StandaloneAudioPart[] = [];
        let tailFinalised = false;
        let unfinishedTailPreserved = false;
        for (
          let partSequence = 1;
          partSequence <= grouped.size;
          partSequence += 1
        ) {
          const partChunks = grouped.get(partSequence);
          if (!partChunks || partChunks.length === 0) {
            throw new PersistenceInvariantError(
              "Audio parts must be stored in sequence.",
            );
          }
          let durationMs = partChunks.at(-1)?.completed_part_duration_ms;
          if (durationMs === null || durationMs === undefined) {
            if (partSequence !== grouped.size) {
              throw new PersistenceInvariantError(
                "Only the final interrupted audio part may be unfinished.",
              );
            }
            const finalChunk = partChunks.at(-1);
            const remainingMs = MAX_SEGMENT_DURATION_MS -
              partChunks[0]!.part_start_offset_ms;
            const elapsedMs = finalChunk?.part_elapsed_ms;
            if (
              finalChunk &&
              Number.isSafeInteger(elapsedMs) &&
              elapsedMs !== undefined &&
              elapsedMs > 0 &&
              elapsedMs <= MAX_STANDALONE_AUDIO_PART_DURATION_MS &&
              remainingMs > 0
            ) {
              durationMs = Math.min(elapsedMs, remainingMs);
              try {
                const candidate = standalonePart(partChunks, durationMs);
                const updated = await this.database.audioChunks.update(finalChunk.id, {
                  completed_part_duration_ms: durationMs,
                });
                if (updated !== 1) {
                  throw new PersistenceInvariantError(
                    "The interrupted audio tail could not be acknowledged.",
                  );
                }
                partChunks[partChunks.length - 1] = {
                  ...finalChunk,
                  completed_part_duration_ms: durationMs,
                };
                parts.push(candidate);
                tailFinalised = true;
                continue;
              } catch {
                // Retain the raw chunks and continue with any completed prefix.
              }
            }
            unfinishedTailPreserved = true;
            break;
          }
          parts.push(standalonePart(partChunks, durationMs));
        }

        if (parts.length === 0) {
          return {
            segment: null,
            parts: [],
            tail_finalised: false,
            unfinished_tail_preserved: true,
          };
        }
        const durationMs = parts.reduce(
          (total, part) => total + part.duration_ms,
          0,
        );
        const byteSize = parts.reduce(
          (total, part) => total + part.byte_size,
          0,
        );
        const timestamp = this.timestamp();
        const finalised: AudioSegmentRecord = {
          ...existing,
          status: "finalised",
          transcription_disposition: "pending",
          failure_code: null,
          duration_ms: durationMs,
          byte_size: byteSize,
          updated_at: timestamp,
        };
        await this.database.audioSegments.put(finalised);
        const story = await this.database.stories.get(existing.client_story_id);
        if (!story) {
          throw new PersistenceRecordNotFoundError("Guest story");
        }
        await this.refreshStoryExpiry(story, timestamp);
        await this.advanceOutbox(story.client_story_id, timestamp);
        return {
          segment: finalised,
          parts,
          tail_finalised: tailFinalised,
          unfinished_tail_preserved: unfinishedTailPreserved,
        };
      },
    );
    return this.acknowledgement(recovered);
  }

  async finaliseAudioSegment(
    input: FinaliseAudioSegmentInput,
  ): Promise<LocalWriteAcknowledgement<AudioSegmentRecord>> {
    assertUuid(input.client_segment_id, "client_segment_id");
    assertPositiveInteger(input.duration_ms, "duration_ms");
    if (input.duration_ms > MAX_SEGMENT_DURATION_MS) {
      throw new InvalidPersistenceInputError(
        "duration_ms exceeds the 30-minute segment limit.",
      );
    }

    const segment = await this.database.transaction(
      "rw",
      this.database.stories,
      this.database.audioSegments,
      this.database.audioChunks,
      this.database.migrationOutbox,
      async () => {
        const existing = await this.database.audioSegments.get(
          input.client_segment_id,
        );
        if (!existing) {
          throw new PersistenceRecordNotFoundError("Audio segment");
        }
        if (existing.status === "finalised") {
          if (existing.duration_ms === input.duration_ms) {
            return existing;
          }
          throw new ImmutableRecordError("Finalised audio segment");
        }

        const chunks = await this.database.audioChunks
          .where("client_segment_id")
          .equals(existing.client_segment_id)
          .sortBy("chunk_sequence_number");
        const byteSize = chunks.reduce(
          (total, chunk) => total + chunk.byte_size,
          0,
        );
        if (byteSize < 1) {
          throw new PersistenceInvariantError(
            "An audio segment cannot be finalised before a chunk is stored.",
          );
        }
        if (!Number.isSafeInteger(byteSize)) {
          throw new PersistenceInvariantError(
            "The audio segment is too large for safe local accounting.",
          );
        }
        const grouped = new Map<number, AudioChunkRecord[]>();
        for (const chunk of chunks) {
          const group = grouped.get(chunk.part_sequence_number) ?? [];
          group.push(chunk);
          grouped.set(chunk.part_sequence_number, group);
        }
        const onlyPart = grouped.size === 1 ? grouped.get(1) : undefined;
        if (
          onlyPart &&
          onlyPart.every(
            (chunk) => chunk.completed_part_duration_ms === null,
          )
        ) {
          const last = onlyPart.at(-1);
          if (!last) {
            throw new PersistenceInvariantError("Audio part is empty.");
          }
          await this.database.audioChunks.update(last.id, {
            completed_part_duration_ms: input.duration_ms,
          });
          onlyPart[onlyPart.length - 1] = {
            ...last,
            completed_part_duration_ms: input.duration_ms,
          };
        }
        let partsDurationMs = 0;
        for (
          let partSequence = 1;
          partSequence <= grouped.size;
          partSequence += 1
        ) {
          const partChunks = grouped.get(partSequence);
          const partDurationMs = partChunks?.at(-1)?.completed_part_duration_ms;
          if (!partChunks || partDurationMs === null || partDurationMs === undefined) {
            throw new PersistenceInvariantError(
              "An audio segment cannot be finalised while a recorder part is unfinished.",
            );
          }
          standalonePart(partChunks, partDurationMs);
          partsDurationMs += partDurationMs;
        }
        if (partsDurationMs !== input.duration_ms) {
          throw new PersistenceInvariantError(
            "Audio segment duration must equal its standalone parts.",
          );
        }

        const timestamp = this.timestamp();
        const finalised: AudioSegmentRecord = {
          ...existing,
          byte_size: byteSize,
          duration_ms: input.duration_ms,
          status: "finalised",
          transcription_disposition: existing.transcription_disposition,
          failure_code: null,
          updated_at: timestamp,
        };
        await this.database.audioSegments.put(finalised);
        const story = await this.database.stories.get(
          finalised.client_story_id,
        );
        if (!story) {
          throw new PersistenceRecordNotFoundError("Guest story");
        }
        await this.refreshStoryExpiry(story, timestamp);
        await this.advanceOutbox(story.client_story_id, timestamp);
        return finalised;
      },
    );

    return this.acknowledgement(segment);
  }

  async failAudioSegment(
    input: FailAudioSegmentInput,
  ): Promise<LocalWriteAcknowledgement<AudioSegmentRecord>> {
    assertUuid(input.client_segment_id, "client_segment_id");
    assertMachineCode(input.failure_code, "failure_code");

    const segment = await this.database.transaction(
      "rw",
      this.database.stories,
      this.database.audioSegments,
      this.database.migrationOutbox,
      async () => {
        const existing = await this.database.audioSegments.get(
          input.client_segment_id,
        );
        if (!existing) {
          throw new PersistenceRecordNotFoundError("Audio segment");
        }
        if (existing.status === "finalised") {
          throw new ImmutableRecordError("Finalised audio segment");
        }

        const timestamp = this.timestamp();
        const failed: AudioSegmentRecord = {
          ...existing,
          status: "failed",
          failure_code: input.failure_code,
          updated_at: timestamp,
        };
        await this.database.audioSegments.put(failed);
        const story = await this.database.stories.get(failed.client_story_id);
        if (!story) {
          throw new PersistenceRecordNotFoundError("Guest story");
        }
        await this.refreshStoryExpiry(story, timestamp);
        return failed;
      },
    );

    return this.acknowledgement(segment);
  }

  async skipAudioTranscription(
    input: SkipAudioTranscriptionInput,
  ): Promise<LocalWriteAcknowledgement<AudioSegmentRecord>> {
    assertUuid(input.client_segment_id, "client_segment_id");
    const segment = await this.database.transaction(
      "rw",
      this.database.stories,
      this.database.audioSegments,
      this.database.migrationOutbox,
      async () => {
        const existing = await this.database.audioSegments.get(
          input.client_segment_id,
        );
        if (!existing) {
          throw new PersistenceRecordNotFoundError("Audio segment");
        }
        if (existing.status !== "finalised") {
          throw new PersistenceInvariantError(
            "Only finalised audio can continue without a transcript.",
          );
        }
        if (existing.transcription_disposition === "complete") {
          throw new ImmutableRecordError("Completed transcription disposition");
        }
        if (existing.transcription_disposition === "skipped") {
          return existing;
        }
        const timestamp = this.timestamp();
        const skipped: AudioSegmentRecord = {
          ...existing,
          transcription_disposition: "skipped",
          updated_at: timestamp,
        };
        await this.database.audioSegments.put(skipped);
        const story = await this.database.stories.get(existing.client_story_id);
        if (!story) {
          throw new PersistenceRecordNotFoundError("Guest story");
        }
        await this.refreshStoryExpiry(story, timestamp);
        await this.advanceOutbox(story.client_story_id, timestamp);
        return skipped;
      },
    );
    return this.acknowledgement(segment);
  }

  async saveOriginalTranscript(
    input: SaveOriginalTranscriptInput,
  ): Promise<LocalWriteAcknowledgement<OriginalTranscriptRecord>> {
    const normalised = normaliseTranscriptInput(input);

    const transcript = await this.database.transaction(
      "rw",
      this.database.stories,
      this.database.audioSegments,
      this.database.originalTranscripts,
      this.database.migrationOutbox,
      async () => {
        const segment = await this.database.audioSegments.get(
          input.client_segment_id,
        );
        if (!segment) {
          throw new PersistenceRecordNotFoundError("Audio segment");
        }
        if (segment.status !== "finalised") {
          throw new PersistenceInvariantError(
            "The original transcript requires a finalised audio segment.",
          );
        }

        const existing = await this.database.originalTranscripts
          .where("client_segment_id")
          .equals(segment.client_segment_id)
          .first();
        if (existing) {
          if (originalTranscriptMatches(existing, normalised)) {
            if (segment.transcription_disposition !== "complete") {
              await this.database.audioSegments.update(
                segment.client_segment_id,
                { transcription_disposition: "complete" },
              );
            }
            return existing;
          }
          throw new ImmutableRecordError("Original transcript");
        }

        const timestamp = this.timestamp();
        const stored: OriginalTranscriptRecord = {
          client_transcript_id: createUuid(),
          client_story_id: segment.client_story_id,
          client_segment_id: segment.client_segment_id,
          transcript_text: normalised.transcript_text,
          language_code: "en",
          uncertainties: structuredClone(normalised.uncertainties),
          transcription_provider: normalised.transcription_provider,
          transcription_model: normalised.transcription_model,
          transcript_sha256: normalised.transcript_sha256,
          created_at: timestamp,
        };
        await this.database.originalTranscripts.add(stored);
        await this.database.audioSegments.update(segment.client_segment_id, {
          transcription_disposition: "complete",
          updated_at: timestamp,
        });
        const story = await this.database.stories.get(stored.client_story_id);
        if (!story) {
          throw new PersistenceRecordNotFoundError("Guest story");
        }
        await this.refreshStoryExpiry(story, timestamp);
        await this.advanceOutbox(story.client_story_id, timestamp);
        return stored;
      },
    );

    return this.acknowledgement(transcript);
  }

  async applyOriginalTranscript(
    input: ApplyOriginalTranscriptInput,
  ): Promise<LocalWriteAcknowledgement<AppliedOriginalTranscript>> {
    const normalised = normaliseTranscriptInput(input);
    assertNonNegativeInteger(input.expected_revision ?? 0, "expected_revision");
    const contentSha256 = normaliseSha256(input.content_sha256);

    const applied: AppliedOriginalTranscript = await this.database.transaction(
      "rw",
      [
        this.database.stories,
        this.database.audioSegments,
        this.database.originalTranscripts,
        this.database.transcriptApplications,
        this.database.storyVersions,
        this.database.migrationOutbox,
      ],
      async (): Promise<AppliedOriginalTranscript> => {
        const segment = await this.database.audioSegments.get(
          input.client_segment_id,
        );
        if (!segment) {
          throw new PersistenceRecordNotFoundError("Audio segment");
        }
        if (segment.status !== "finalised") {
          throw new PersistenceInvariantError(
            "The original transcript requires a finalised audio segment.",
          );
        }

        const story = await this.database.stories.get(segment.client_story_id);
        if (!story) {
          throw new PersistenceRecordNotFoundError("Guest story");
        }

        const existingApplication =
          await this.database.transcriptApplications.get(
            segment.client_segment_id,
          );
        if (existingApplication) {
          const [originalTranscript, storyVersion] = await Promise.all([
            this.database.originalTranscripts.get(
              existingApplication.client_transcript_id,
            ),
            this.database.storyVersions.get(
              existingApplication.client_version_id,
            ),
          ]);
          if (!originalTranscript || !storyVersion) {
            throw new PersistenceInvariantError(
              "The transcript application checkpoint is incomplete.",
            );
          }

          const linksAreValid =
            existingApplication.client_story_id === story.client_story_id &&
            originalTranscript.client_story_id === story.client_story_id &&
            originalTranscript.client_segment_id === segment.client_segment_id &&
            storyVersion.client_story_id === story.client_story_id &&
            storyVersion.reason === "transcript";
          const retryIsIdentical =
            originalTranscriptMatches(originalTranscript, normalised) &&
            storyVersion.story_text === input.current_text &&
            storyVersion.content_sha256 === contentSha256;
          if (!linksAreValid) {
            throw new PersistenceInvariantError(
              "The transcript application checkpoint is inconsistent.",
            );
          }
          if (!retryIsIdentical) {
            throw new ImmutableRecordError("Transcript application");
          }

          if (segment.transcription_disposition !== "complete") {
            await this.database.audioSegments.update(segment.client_segment_id, {
              transcription_disposition: "complete",
              updated_at: this.timestamp(),
            });
          }

          return {
            application: existingApplication,
            original_transcript: originalTranscript,
            story_version: storyVersion,
            story,
          };
        }

        if (
          input.expected_revision !== undefined &&
          input.expected_revision !== story.revision
        ) {
          throw new StaleStoryRevisionError(
            input.expected_revision,
            story.revision,
          );
        }

        const timestamp = this.timestamp();
        const existingOriginal = await this.database.originalTranscripts
          .where("client_segment_id")
          .equals(segment.client_segment_id)
          .first();
        let originalTranscript: OriginalTranscriptRecord;
        if (existingOriginal) {
          if (!originalTranscriptMatches(existingOriginal, normalised)) {
            throw new ImmutableRecordError("Original transcript");
          }
          originalTranscript = existingOriginal;
        } else {
          originalTranscript = {
            client_transcript_id: createUuid(),
            client_story_id: segment.client_story_id,
            client_segment_id: segment.client_segment_id,
            transcript_text: normalised.transcript_text,
            language_code: "en",
            uncertainties: structuredClone(normalised.uncertainties),
            transcription_provider: normalised.transcription_provider,
            transcription_model: normalised.transcription_model,
            transcript_sha256: normalised.transcript_sha256,
            created_at: timestamp,
          };
          await this.database.originalTranscripts.add(originalTranscript);
        }

        const lastVersion = await this.database.storyVersions
          .where("[client_story_id+version_number]")
          .between(
            [story.client_story_id, Dexie.minKey],
            [story.client_story_id, Dexie.maxKey],
          )
          .last();
        const storyVersion: StoryVersionRecord = {
          client_version_id: createUuid(),
          client_story_id: story.client_story_id,
          version_number: (lastVersion?.version_number ?? 0) + 1,
          story_text: input.current_text,
          reason: "transcript",
          restored_from_version_id: null,
          content_sha256: contentSha256,
          created_at: timestamp,
        };
        await this.database.storyVersions.add(storyVersion);

        const updatedStory: GuestStoryRecord = {
          ...story,
          current_text: input.current_text,
          current_version_id: storyVersion.client_version_id,
          revision: story.revision + 1,
          updated_at: timestamp,
          expires_at: timestamp + THIRTY_DAYS_MS,
        };
        await this.database.stories.put(updatedStory);
        const outbox = await this.advanceOutbox(
          story.client_story_id,
          timestamp,
        );

        const application: TranscriptApplicationRecord = {
          client_segment_id: segment.client_segment_id,
          client_story_id: story.client_story_id,
          client_transcript_id: originalTranscript.client_transcript_id,
          client_version_id: storyVersion.client_version_id,
          applied_story_revision: updatedStory.revision,
          payload_generation: outbox.payload_generation,
          created_at: timestamp,
        };
        await this.database.transcriptApplications.add(application);
        await this.database.audioSegments.update(segment.client_segment_id, {
          transcription_disposition: "complete",
          updated_at: timestamp,
        });

        return {
          application,
          original_transcript: originalTranscript,
          story_version: storyVersion,
          story: updatedStory,
        };
      },
    );

    return this.acknowledgement(applied);
  }

  async appendStoryVersion(
    input: AppendStoryVersionInput,
  ): Promise<LocalWriteAcknowledgement<StoryVersionRecord>> {
    assertVersionReason(input.reason);
    const contentSha256 = normaliseSha256(input.content_sha256);

    const version = await this.database.transaction(
      "rw",
      this.database.stories,
      this.database.storyVersions,
      this.database.migrationOutbox,
      async () => {
        const story = await this.activeStory();
        if (!story) {
          throw new PersistenceRecordNotFoundError("Guest story");
        }
        const lastVersion = await this.database.storyVersions
          .where("[client_story_id+version_number]")
          .between(
            [story.client_story_id, Dexie.minKey],
            [story.client_story_id, Dexie.maxKey],
          )
          .last();
        const timestamp = this.timestamp();
        const stored: StoryVersionRecord = {
          client_version_id: createUuid(),
          client_story_id: story.client_story_id,
          version_number: (lastVersion?.version_number ?? 0) + 1,
          story_text: story.current_text,
          reason: input.reason,
          restored_from_version_id: null,
          content_sha256: contentSha256,
          created_at: timestamp,
        };
        await this.database.storyVersions.add(stored);
        const updatedStory: GuestStoryRecord = {
          ...story,
          current_version_id: stored.client_version_id,
          revision: story.revision + 1,
          updated_at: timestamp,
          expires_at: timestamp + THIRTY_DAYS_MS,
        };
        await this.database.stories.put(updatedStory);
        await this.advanceOutbox(story.client_story_id, timestamp);
        return stored;
      },
    );

    return this.acknowledgement(version);
  }

  async ensureCurrentStoryVersion(
    input: AppendStoryVersionInput,
  ): Promise<LocalWriteAcknowledgement<StoryVersionRecord>> {
    assertVersionReason(input.reason);
    const contentSha256 = normaliseSha256(input.content_sha256);

    const version = await this.database.transaction(
      "rw",
      this.database.stories,
      this.database.storyVersions,
      this.database.migrationOutbox,
      async () => {
        const story = await this.activeStory();
        if (!story) {
          throw new PersistenceRecordNotFoundError("Guest story");
        }
        const current = story.current_version_id
          ? await this.database.storyVersions.get(story.current_version_id)
          : undefined;
        if (
          current &&
          current.client_story_id === story.client_story_id &&
          current.story_text === story.current_text
        ) {
          return current;
        }

        const lastVersion = await this.database.storyVersions
          .where("[client_story_id+version_number]")
          .between(
            [story.client_story_id, Dexie.minKey],
            [story.client_story_id, Dexie.maxKey],
          )
          .last();
        const timestamp = this.timestamp();
        const stored: StoryVersionRecord = {
          client_version_id: createUuid(),
          client_story_id: story.client_story_id,
          version_number: (lastVersion?.version_number ?? 0) + 1,
          story_text: story.current_text,
          reason: input.reason,
          restored_from_version_id: null,
          content_sha256: contentSha256,
          created_at: timestamp,
        };
        await this.database.storyVersions.add(stored);
        await this.database.stories.put({
          ...story,
          current_version_id: stored.client_version_id,
          revision: story.revision + 1,
          updated_at: timestamp,
          expires_at: timestamp + THIRTY_DAYS_MS,
        });
        await this.advanceOutbox(story.client_story_id, timestamp);
        return stored;
      },
    );

    return this.acknowledgement(version);
  }

  async restoreStoryVersion(
    input: RestoreStoryVersionInput,
  ): Promise<LocalWriteAcknowledgement<RestoredStoryText>> {
    assertUuid(input.client_version_id, "client_version_id");
    const contentSha256 = normaliseSha256(input.content_sha256);

    const restored = await this.database.transaction(
      "rw",
      this.database.stories,
      this.database.storyVersions,
      this.database.migrationOutbox,
      async () => {
        const story = await this.activeStory();
        if (!story) {
          throw new PersistenceRecordNotFoundError("Guest story");
        }
        const source = await this.database.storyVersions.get(
          input.client_version_id,
        );
        if (!source || source.client_story_id !== story.client_story_id) {
          throw new PersistenceRecordNotFoundError("Story version");
        }
        const lastVersion = await this.database.storyVersions
          .where("[client_story_id+version_number]")
          .between(
            [story.client_story_id, Dexie.minKey],
            [story.client_story_id, Dexie.maxKey],
          )
          .last();
        const timestamp = this.timestamp();
        const version: StoryVersionRecord = {
          client_version_id: createUuid(),
          client_story_id: story.client_story_id,
          version_number: (lastVersion?.version_number ?? 0) + 1,
          story_text: source.story_text,
          reason: "restore",
          restored_from_version_id: source.client_version_id,
          content_sha256: contentSha256,
          created_at: timestamp,
        };
        await this.database.storyVersions.add(version);

        const updatedStory: GuestStoryRecord = {
          ...story,
          current_text: source.story_text,
          current_version_id: version.client_version_id,
          revision: story.revision + 1,
          updated_at: timestamp,
          expires_at: timestamp + THIRTY_DAYS_MS,
        };
        await this.database.stories.put(updatedStory);
        await this.advanceOutbox(story.client_story_id, timestamp);
        return { story: updatedStory, version };
      },
    );

    return this.acknowledgement(restored);
  }

  async restoreExternalStoryText(
    input: RestoreExternalStoryTextInput,
  ): Promise<LocalWriteAcknowledgement<RestoredStoryText>> {
    assertNonNegativeInteger(input.expected_revision ?? 0, "expected_revision");
    const contentSha256 = normaliseSha256(input.content_sha256);

    const restored = await this.database.transaction(
      "rw",
      this.database.stories,
      this.database.storyVersions,
      this.database.migrationOutbox,
      async (): Promise<RestoredStoryText> => {
        const story = await this.activeStory();
        if (!story) {
          throw new PersistenceRecordNotFoundError("Guest story");
        }

        const currentVersion = story.current_version_id
          ? await this.database.storyVersions.get(story.current_version_id)
          : undefined;
        const isIdenticalExternalRestore =
          currentVersion !== undefined &&
          currentVersion.client_story_id === story.client_story_id &&
          currentVersion.reason === "restore" &&
          currentVersion.restored_from_version_id === null &&
          currentVersion.story_text === input.story_text &&
          currentVersion.content_sha256 === contentSha256 &&
          story.current_text === input.story_text;

        if (
          input.expected_revision !== undefined &&
          input.expected_revision !== story.revision
        ) {
          const isAcknowledgementRetry =
            input.expected_revision + 1 === story.revision &&
            isIdenticalExternalRestore;
          if (!isAcknowledgementRetry) {
            throw new StaleStoryRevisionError(
              input.expected_revision,
              story.revision,
            );
          }
        }

        if (isIdenticalExternalRestore && currentVersion) {
          return { story, version: currentVersion };
        }

        const lastVersion = await this.database.storyVersions
          .where("[client_story_id+version_number]")
          .between(
            [story.client_story_id, Dexie.minKey],
            [story.client_story_id, Dexie.maxKey],
          )
          .last();
        const timestamp = this.timestamp();
        const version: StoryVersionRecord = {
          client_version_id: createUuid(),
          client_story_id: story.client_story_id,
          version_number: (lastVersion?.version_number ?? 0) + 1,
          story_text: input.story_text,
          reason: "restore",
          restored_from_version_id: null,
          content_sha256: contentSha256,
          created_at: timestamp,
        };
        await this.database.storyVersions.add(version);

        const updatedStory: GuestStoryRecord = {
          ...story,
          current_text: input.story_text,
          current_version_id: version.client_version_id,
          revision: story.revision + 1,
          updated_at: timestamp,
          expires_at: timestamp + THIRTY_DAYS_MS,
        };
        await this.database.stories.put(updatedStory);
        await this.advanceOutbox(story.client_story_id, timestamp);

        return { story: updatedStory, version };
      },
    );

    return this.acknowledgement(restored);
  }

  async resolveCloudStoryConflict(
    input: ResolveCloudStoryConflictInput,
  ): Promise<LocalWriteAcknowledgement<RestoredStoryText>> {
    assertUuid(input.client_story_id, "client_story_id");
    assertUuid(input.story_id, "story_id");
    assertNonNegativeInteger(
      input.expected_story_revision,
      "expected_story_revision",
    );
    assertNonNegativeInteger(
      input.expected_acknowledged_cloud_revision,
      "expected_acknowledged_cloud_revision",
    );
    assertNonNegativeInteger(
      input.incumbent_cloud_revision,
      "incumbent_cloud_revision",
    );
    if (
      input.incumbent_cloud_revision <=
      input.expected_acknowledged_cloud_revision
    ) {
      throw new InvalidPersistenceInputError(
        "incumbent_cloud_revision must be newer than the acknowledged base.",
      );
    }
    if (input.incumbent_cloud_version_id !== null) {
      assertUuid(
        input.incumbent_cloud_version_id,
        "incumbent_cloud_version_id",
      );
    }
    if (input.selection.kind === "local-version") {
      assertUuid(input.selection.client_version_id, "client_version_id");
    } else {
      if (typeof input.selection.story_text !== "string") {
        throw new InvalidPersistenceInputError(
          "story_text must be a string.",
        );
      }
      if (input.selection.cloud_version_id !== null) {
        assertUuid(input.selection.cloud_version_id, "cloud_version_id");
      }
    }

    const restored = await this.database.transaction(
      "rw",
      this.database.stories,
      this.database.storyVersions,
      this.database.migrationOutbox,
      this.database.migrationReceipts,
      async (): Promise<RestoredStoryText> => {
        const story = await this.database.stories.get(input.client_story_id);
        if (!story || story.guest_slot !== ACTIVE_GUEST_SLOT) {
          throw new PersistenceRecordNotFoundError("Guest story");
        }
        if (story.revision !== input.expected_story_revision) {
          throw new StaleStoryRevisionError(
            input.expected_story_revision,
            story.revision,
          );
        }

        const [outbox, receipt] = await Promise.all([
          this.database.migrationOutbox
            .where("client_story_id")
            .equals(input.client_story_id)
            .first(),
          this.database.migrationReceipts
            .where("client_story_id")
            .equals(input.client_story_id)
            .first(),
        ]);
        if (
          !outbox ||
          !receipt ||
          receipt.story_id !== input.story_id ||
          outbox.last_acknowledged_cloud_revision !==
            input.expected_acknowledged_cloud_revision
        ) {
          throw new MigrationConflictError();
        }

        let selectedText: string;
        let restoredFromVersionId: Uuid | null;
        if (input.selection.kind === "local-version") {
          const selected = await this.database.storyVersions.get(
            input.selection.client_version_id,
          );
          if (!selected || selected.client_story_id !== story.client_story_id) {
            throw new PersistenceRecordNotFoundError("Story version");
          }
          selectedText = selected.story_text;
          restoredFromVersionId = selected.client_version_id;
        } else {
          selectedText = input.selection.story_text;
          restoredFromVersionId = input.selection.cloud_version_id;
        }

        const lastVersion = await this.database.storyVersions
          .where("[client_story_id+version_number]")
          .between(
            [story.client_story_id, Dexie.minKey],
            [story.client_story_id, Dexie.maxKey],
          )
          .last();
        const timestamp = this.timestamp();
        const version: StoryVersionRecord = {
          client_version_id: createUuid(),
          client_story_id: story.client_story_id,
          version_number: (lastVersion?.version_number ?? 0) + 1,
          story_text: selectedText,
          reason: "conflict-resolution",
          restored_from_version_id: restoredFromVersionId,
          content_sha256: null,
          created_at: timestamp,
        };
        const updatedStory: GuestStoryRecord = {
          ...story,
          current_text: selectedText,
          current_version_id: version.client_version_id,
          revision: story.revision + 1,
          updated_at: timestamp,
          expires_at: timestamp + THIRTY_DAYS_MS,
        };
        const rebasedOutbox: MigrationOutboxRecord = {
          ...outbox,
          state: "pending",
          payload_generation: outbox.payload_generation + 1,
          last_acknowledged_cloud_revision:
            input.incumbent_cloud_revision,
          last_acknowledged_cloud_version_id:
            input.incumbent_cloud_version_id,
          attempted_generation: null,
          last_failure_code: null,
          updated_at: timestamp,
        };

        await this.database.storyVersions.add(version);
        await this.database.stories.put(updatedStory);
        await this.database.migrationOutbox.put(rebasedOutbox);
        return { story: updatedStory, version };
      },
    );

    return this.acknowledgement(restored);
  }

  private async deleteStoryRows(clientStoryId: Uuid): Promise<void> {
    await Promise.all([
      this.database.audioChunks
        .where("client_story_id")
        .equals(clientStoryId)
        .delete(),
      this.database.originalTranscripts
        .where("client_story_id")
        .equals(clientStoryId)
        .delete(),
      this.database.transcriptApplications
        .where("client_story_id")
        .equals(clientStoryId)
        .delete(),
      this.database.storyVersions
        .where("client_story_id")
        .equals(clientStoryId)
        .delete(),
      this.database.audioSegments
        .where("client_story_id")
        .equals(clientStoryId)
        .delete(),
      this.database.migrationOutbox
        .where("client_story_id")
        .equals(clientStoryId)
        .delete(),
      this.database.migrationReceipts
        .where("client_story_id")
        .equals(clientStoryId)
        .delete(),
    ]);
    await this.database.stories.delete(clientStoryId);
  }

  async recoverGuestDraft(): Promise<RecoveredGuestDraft | null> {
    return this.database.transaction(
      "rw",
      [
        this.database.stories,
        this.database.audioSegments,
        this.database.audioChunks,
        this.database.originalTranscripts,
        this.database.transcriptApplications,
        this.database.storyVersions,
        this.database.migrationOutbox,
        this.database.migrationReceipts,
      ],
      async () => {
        const story = await this.activeStory();
        if (!story) {
          return null;
        }
        if (story.expires_at <= this.timestamp()) {
          await this.deleteStoryRows(story.client_story_id);
          return null;
        }

        const [
          audioSegments,
          originalTranscripts,
          transcriptApplications,
          storyVersions,
          migrationOutbox,
          migrationReceipt,
        ] = await Promise.all([
          this.database.audioSegments
            .where("client_story_id")
            .equals(story.client_story_id)
            .sortBy("sequence_number"),
          this.database.originalTranscripts
            .where("client_story_id")
            .equals(story.client_story_id)
            .sortBy("created_at"),
          this.database.transcriptApplications
            .where("client_story_id")
            .equals(story.client_story_id)
            .sortBy("created_at"),
          this.database.storyVersions
            .where("client_story_id")
            .equals(story.client_story_id)
            .sortBy("version_number"),
          this.database.migrationOutbox
            .where("client_story_id")
            .equals(story.client_story_id)
            .first(),
          this.database.migrationReceipts
            .where("client_story_id")
            .equals(story.client_story_id)
            .first(),
        ]);
        if (!migrationOutbox) {
          throw new PersistenceRecordNotFoundError("Migration outbox");
        }

        return {
          story,
          audio_segments: audioSegments,
          original_transcripts: originalTranscripts,
          transcript_applications: transcriptApplications,
          story_versions: storyVersions,
          migration_outbox: migrationOutbox,
          migration_receipt: migrationReceipt ?? null,
          has_local_changes_after_migration:
            migrationReceipt !== undefined &&
            migrationOutbox.payload_generation >
              migrationOutbox.cloud_synced_generation,
        };
      },
    );
  }

  async purgeExpiredGuestDrafts(): Promise<LocalWriteAcknowledgement<number>> {
    const purgedCount = await this.database.transaction(
      "rw",
      [
        this.database.stories,
        this.database.audioSegments,
        this.database.audioChunks,
        this.database.originalTranscripts,
        this.database.transcriptApplications,
        this.database.storyVersions,
        this.database.migrationOutbox,
        this.database.migrationReceipts,
      ],
      async () => {
        const story = await this.activeStory();
        if (!story || story.expires_at > this.timestamp()) {
          return 0;
        }
        await this.deleteStoryRows(story.client_story_id);
        return 1;
      },
    );
    return this.acknowledgement(purgedCount);
  }

  async discardGuestDraft(
    input: DiscardGuestDraftInput,
  ): Promise<LocalWriteAcknowledgement<boolean>> {
    assertUuid(input.client_story_id, "client_story_id");
    const discarded = await this.database.transaction(
      "rw",
      [
        this.database.stories,
        this.database.audioSegments,
        this.database.audioChunks,
        this.database.originalTranscripts,
        this.database.transcriptApplications,
        this.database.storyVersions,
        this.database.migrationOutbox,
        this.database.migrationReceipts,
      ],
      async () => {
        const story = await this.activeStory();
        if (!story) {
          return false;
        }
        if (story.client_story_id !== input.client_story_id) {
          throw new PersistenceInvariantError(
            "The active guest draft changed before it could be discarded.",
          );
        }
        await this.deleteStoryRows(story.client_story_id);
        return true;
      },
    );
    return this.acknowledgement(discarded);
  }

  async clearCloudAcknowledgedStory(
    input: ClearCloudAcknowledgedStoryInput,
  ): Promise<LocalWriteAcknowledgement<boolean>> {
    assertUuid(input.client_story_id, "client_story_id");
    const cleared = await this.database.transaction(
      "rw",
      [
        this.database.stories,
        this.database.audioSegments,
        this.database.audioChunks,
        this.database.originalTranscripts,
        this.database.transcriptApplications,
        this.database.storyVersions,
        this.database.migrationOutbox,
        this.database.migrationReceipts,
      ],
      async () => {
        const story = await this.activeStory();
        if (!story) {
          return false;
        }
        if (story.client_story_id !== input.client_story_id) {
          throw new PersistenceInvariantError(
            "The active local story changed before a fresh canvas could open.",
          );
        }

        const [outbox, receipt, segments] = await Promise.all([
          this.database.migrationOutbox
            .where("client_story_id")
            .equals(story.client_story_id)
            .first(),
          this.database.migrationReceipts
            .where("client_story_id")
            .equals(story.client_story_id)
            .first(),
          this.database.audioSegments
            .where("client_story_id")
            .equals(story.client_story_id)
            .toArray(),
        ]);
        const cloudAcknowledged =
          receipt !== undefined &&
          outbox !== undefined &&
          outbox.state === "completed" &&
          outbox.payload_generation === outbox.cloud_synced_generation &&
          outbox.last_acknowledged_cloud_revision !== null;
        const recordingNeedsAttention = segments.some(
          (segment) =>
            segment.status === "recording" ||
            segment.transcription_disposition === "pending",
        );
        if (!cloudAcknowledged || recordingNeedsAttention) {
          throw new PersistenceInvariantError(
            "The active local story is not fully acknowledged by the cloud.",
          );
        }

        await this.deleteStoryRows(story.client_story_id);
        return true;
      },
    );
    return this.acknowledgement(cleared);
  }

  async adoptCloudStory(
    input: AdoptCloudStoryInput,
  ): Promise<LocalWriteAcknowledgement<GuestStoryRecord>> {
    validateAdoptCloudStoryInput(input);

    const story = await this.database.transaction(
      "rw",
      this.database.stories,
      this.database.migrationOutbox,
      this.database.migrationReceipts,
      async () => {
        const existing = await this.activeStory();
        if (existing) {
          const receipt = await this.database.migrationReceipts
            .where("client_story_id")
            .equals(existing.client_story_id)
            .first();
          if (
            existing.client_story_id === input.client_story_id &&
            existing.current_text === input.current_text &&
            existing.title === input.title &&
            receipt?.owner_id === input.owner_id &&
            receipt.story_id === input.story_id
          ) {
            return existing;
          }
          throw new PersistenceInvariantError(
            "The active local story must be safely cleared before another cloud story is opened.",
          );
        }

        return this.createAdoptedCloudStory(input, this.timestamp());
      },
    );

    return this.acknowledgement(story);
  }

  async replaceActiveWithCloudStory(
    input: ReplaceActiveWithCloudStoryInput,
  ): Promise<LocalWriteAcknowledgement<GuestStoryRecord>> {
    assertUuid(
      input.expected_current_client_story_id,
      "expected_current_client_story_id",
    );
    validateAdoptCloudStoryInput(input);

    const story = await this.database.transaction(
      "rw",
      [
        this.database.stories,
        this.database.audioSegments,
        this.database.audioChunks,
        this.database.originalTranscripts,
        this.database.transcriptApplications,
        this.database.storyVersions,
        this.database.migrationOutbox,
        this.database.migrationReceipts,
      ],
      async () => {
        const existing = await this.activeStory();
        if (!existing) {
          throw new PersistenceRecordNotFoundError("Guest story");
        }
        if (
          existing.client_story_id !==
          input.expected_current_client_story_id
        ) {
          throw new PersistenceInvariantError(
            "The active local story changed before it could be replaced.",
          );
        }

        await this.deleteStoryRows(existing.client_story_id);
        return this.createAdoptedCloudStory(input, this.timestamp());
      },
    );

    return this.acknowledgement(story);
  }

  async getMigrationOutbox(): Promise<MigrationOutboxRecord | null> {
    const story = await this.activeStory();
    if (!story) {
      return null;
    }
    return (
      (await this.database.migrationOutbox
        .where("client_story_id")
        .equals(story.client_story_id)
        .first()) ?? null
    );
  }

  async beginMigration(): Promise<
    LocalWriteAcknowledgement<MigrationAttempt>
  > {
    const attempt = await this.database.transaction(
      "rw",
      this.database.stories,
      this.database.migrationOutbox,
      this.database.migrationReceipts,
      async () => {
        const story = await this.activeStory();
        if (!story) {
          throw new PersistenceRecordNotFoundError("Guest story");
        }
        const outbox = await this.database.migrationOutbox
          .where("client_story_id")
          .equals(story.client_story_id)
          .first();
        if (!outbox) {
          throw new PersistenceRecordNotFoundError("Migration outbox");
        }
        const receipt = await this.database.migrationReceipts
          .where("client_story_id")
          .equals(story.client_story_id)
          .first();
        if (receipt) {
          throw new PersistenceInvariantError(
            "The guest claim is complete; use authenticated cloud sync.",
          );
        }
        const timestamp = this.timestamp();
        const updated: MigrationOutboxRecord = {
          ...outbox,
          state: outbox.state === "completed" ? "completed" : "in-flight",
          attempted_generation: outbox.payload_generation,
          attempt_count: outbox.attempt_count + 1,
          last_attempt_at: timestamp,
          last_failure_code: null,
          updated_at: timestamp,
        };
        await this.database.migrationOutbox.put(updated);
        return {
          idempotency_key: updated.idempotency_key,
          client_story_id: updated.client_story_id,
          payload_generation: updated.payload_generation,
          attempt_count: updated.attempt_count,
        };
      },
    );
    return this.acknowledgement(attempt);
  }

  async beginCloudSync(): Promise<
    LocalWriteAcknowledgement<CloudSyncAttempt>
  > {
    const attempt = await this.database.transaction(
      "rw",
      this.database.stories,
      this.database.migrationOutbox,
      this.database.migrationReceipts,
      async () => {
        const story = await this.activeStory();
        if (!story) {
          throw new PersistenceRecordNotFoundError("Guest story");
        }
        const [outbox, receipt] = await Promise.all([
          this.database.migrationOutbox
            .where("client_story_id")
            .equals(story.client_story_id)
            .first(),
          this.database.migrationReceipts
            .where("client_story_id")
            .equals(story.client_story_id)
            .first(),
        ]);
        if (!outbox) {
          throw new PersistenceRecordNotFoundError("Migration outbox");
        }
        if (!receipt) {
          throw new PersistenceInvariantError(
            "The guest story must be claimed before authenticated cloud sync.",
          );
        }
        if (outbox.payload_generation <= outbox.cloud_synced_generation) {
          throw new PersistenceInvariantError(
            "No local changes are waiting for cloud sync.",
          );
        }
        if (outbox.last_acknowledged_cloud_revision === null) {
          throw new PersistenceInvariantError(
            "The acknowledged cloud revision is unavailable.",
          );
        }

        const timestamp = this.timestamp();
        const updated: MigrationOutboxRecord = {
          ...outbox,
          state: "in-flight",
          attempted_generation: outbox.payload_generation,
          attempt_count: outbox.attempt_count + 1,
          last_attempt_at: timestamp,
          last_failure_code: null,
          updated_at: timestamp,
        };
        await this.database.migrationOutbox.put(updated);
        return {
          owner_id: receipt.owner_id,
          story_id: receipt.story_id,
          client_story_id: receipt.client_story_id,
          payload_generation: updated.payload_generation,
          attempt_count: updated.attempt_count,
          last_acknowledged_cloud_revision:
            outbox.last_acknowledged_cloud_revision,
          last_acknowledged_cloud_version_id:
            outbox.last_acknowledged_cloud_version_id,
        };
      },
    );
    return this.acknowledgement(attempt);
  }

  async failMigration(
    input: FailMigrationInput,
  ): Promise<LocalWriteAcknowledgement<MigrationOutboxRecord>> {
    assertUuid(input.idempotency_key, "idempotency_key");
    assertMachineCode(input.failure_code, "failure_code");
    const outbox = await this.database.transaction(
      "rw",
      this.database.migrationOutbox,
      async () => {
        const existing = await this.database.migrationOutbox.get(
          input.idempotency_key,
        );
        if (!existing) {
          throw new PersistenceRecordNotFoundError("Migration outbox");
        }
        if (existing.state === "completed") {
          return existing;
        }
        const failed: MigrationOutboxRecord = {
          ...existing,
          state: "pending",
          last_failure_code: input.failure_code,
          updated_at: this.timestamp(),
        };
        await this.database.migrationOutbox.put(failed);
        return failed;
      },
    );
    return this.acknowledgement(outbox);
  }

  async markMigration(
    input: MarkMigrationInput,
  ): Promise<LocalWriteAcknowledgement<MigrationReceiptRecord>> {
    assertUuid(input.owner_id, "owner_id");
    assertUuid(input.story_id, "story_id");
    assertUuid(input.idempotency_key, "idempotency_key");
    assertPositiveInteger(input.payload_generation, "payload_generation");
    assertNonNegativeInteger(input.cloud_revision, "cloud_revision");
    if (input.cloud_version_id !== null) {
      assertUuid(input.cloud_version_id, "cloud_version_id");
    }
    const payloadSha256 = normaliseSha256(input.payload_sha256);

    const receipt = await this.database.transaction(
      "rw",
      this.database.stories,
      this.database.migrationOutbox,
      this.database.migrationReceipts,
      async () => {
        const outbox = await this.database.migrationOutbox.get(
          input.idempotency_key,
        );
        if (!outbox) {
          throw new PersistenceRecordNotFoundError("Migration outbox");
        }
        const existing = await this.database.migrationReceipts
          .where("idempotency_key")
          .equals(input.idempotency_key)
          .first();
        if (existing) {
          const identical =
            existing.owner_id === input.owner_id &&
            existing.story_id === input.story_id &&
            existing.payload_sha256 === payloadSha256 &&
            existing.migrated_generation === input.payload_generation;
          if (!identical) {
            throw new MigrationConflictError();
          }
          const timestamp = this.timestamp();
          await this.database.migrationOutbox.put({
            ...outbox,
            state:
              outbox.payload_generation === input.payload_generation
                ? "completed"
                : "pending",
            cloud_synced_generation: Math.max(
              outbox.cloud_synced_generation,
              input.payload_generation,
            ),
            last_acknowledged_cloud_revision: input.cloud_revision,
            last_acknowledged_cloud_version_id: input.cloud_version_id,
            attempted_generation: input.payload_generation,
            last_failure_code: null,
            updated_at: timestamp,
          });
          return existing;
        }
        if (
          input.payload_generation > outbox.payload_generation ||
          (outbox.attempted_generation !== null &&
            input.payload_generation !== outbox.attempted_generation)
        ) {
          throw new MigrationConflictError();
        }

        const timestamp = this.timestamp();
        const stored: MigrationReceiptRecord = {
          id: createUuid(),
          owner_id: input.owner_id,
          idempotency_key: input.idempotency_key,
          guest_draft_id: outbox.client_story_id,
          client_story_id: outbox.client_story_id,
          story_id: input.story_id,
          payload_sha256: payloadSha256,
          migrated_generation: input.payload_generation,
          created_at: timestamp,
        };
        await this.database.migrationReceipts.add(stored);
        await this.database.migrationOutbox.put({
          ...outbox,
          state:
            outbox.payload_generation === input.payload_generation
              ? "completed"
              : "pending",
          cloud_synced_generation: Math.max(
            outbox.cloud_synced_generation,
            input.payload_generation,
          ),
          last_acknowledged_cloud_revision: input.cloud_revision,
          last_acknowledged_cloud_version_id: input.cloud_version_id,
          attempted_generation: input.payload_generation,
          last_failure_code: null,
          updated_at: timestamp,
        });
        return stored;
      },
    );

    return this.acknowledgement(receipt);
  }

  async acknowledgeCloudSync(
    input: AcknowledgeCloudSyncInput,
  ): Promise<LocalWriteAcknowledgement<MigrationOutboxRecord>> {
    assertUuid(input.client_story_id, "client_story_id");
    assertUuid(input.story_id, "story_id");
    assertPositiveInteger(input.payload_generation, "payload_generation");
    assertNonNegativeInteger(input.cloud_revision, "cloud_revision");
    if (input.cloud_version_id !== null) {
      assertUuid(input.cloud_version_id, "cloud_version_id");
    }

    const outbox = await this.database.transaction(
      "rw",
      this.database.migrationOutbox,
      this.database.migrationReceipts,
      async () => {
        const [existing, receipt] = await Promise.all([
          this.database.migrationOutbox
            .where("client_story_id")
            .equals(input.client_story_id)
            .first(),
          this.database.migrationReceipts
            .where("client_story_id")
            .equals(input.client_story_id)
            .first(),
        ]);
        if (!existing) {
          throw new PersistenceRecordNotFoundError("Migration outbox");
        }
        if (!receipt || receipt.story_id !== input.story_id) {
          throw new MigrationConflictError();
        }
        if (
          input.payload_generation > existing.payload_generation ||
          existing.attempted_generation === null ||
          input.payload_generation > existing.attempted_generation
        ) {
          throw new MigrationConflictError();
        }

        const cloudSyncedGeneration = Math.max(
          existing.cloud_synced_generation,
          input.payload_generation,
        );
        const acknowledged: MigrationOutboxRecord = {
          ...existing,
          state:
            existing.payload_generation === cloudSyncedGeneration
              ? "completed"
              : "pending",
          cloud_synced_generation: cloudSyncedGeneration,
          last_acknowledged_cloud_revision: input.cloud_revision,
          last_acknowledged_cloud_version_id: input.cloud_version_id,
          last_failure_code: null,
          updated_at: this.timestamp(),
        };
        await this.database.migrationOutbox.put(acknowledged);
        return acknowledged;
      },
    );
    return this.acknowledgement(outbox);
  }

  close(): void {
    this.database.close();
  }
}

export function createGuestPersistence(
  options: GuestPersistenceOptions = {},
): GuestPersistence {
  return new DexieGuestPersistence(options);
}
