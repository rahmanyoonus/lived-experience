import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AudioChunkSequenceError,
  createGuestPersistence,
  ImmutableRecordError,
  MigrationConflictError,
  StaleStoryRevisionError,
  type GuestPersistence,
} from ".";

const DAY_MS = 24 * 60 * 60 * 1_000;

describe("guest persistence", () => {
  let databaseName: string;
  let persistence: GuestPersistence;
  let now: Date;

  beforeEach(() => {
    databaseName = `lived-experience-test-${crypto.randomUUID()}`;
    now = new Date("2026-07-19T00:00:00.000Z");
    persistence = createGuestPersistence({
      databaseName,
      now: () => now,
    });
  });

  afterEach(async () => {
    persistence.close();
    await Dexie.delete(databaseName);
  });

  it("does not create a record for an untouched canvas", async () => {
    await expect(
      persistence.ensureStory({ kind: "text", current_text: "" }),
    ).resolves.toBeNull();
    await expect(
      persistence.saveText({ current_text: "" }),
    ).resolves.toBeNull();

    await expect(persistence.recoverGuestDraft()).resolves.toBeNull();
  });

  it("proves device storage without creating or retaining a story", async () => {
    await expect(persistence.probeReadiness()).resolves.toMatchObject({
      persisted: true,
      acknowledged_at: now.getTime(),
      value: true,
    });
    await expect(persistence.recoverGuestDraft()).resolves.toBeNull();

    const inspection = new Dexie(databaseName);
    await inspection.open();
    await expect(inspection.table("readinessProbes").count()).resolves.toBe(0);
    inspection.close();
  });

  it("acknowledges text only after it can be recovered from IndexedDB", async () => {
    const fictionalStory =
      "On a fictional Tuesday, Mira repaired the blue gate by the orchard.";
    const acknowledgement = await persistence.saveText({
      current_text: fictionalStory,
      expected_revision: 0,
    });

    expect(acknowledgement).toMatchObject({
      persisted: true,
      acknowledged_at: now.getTime(),
      value: {
        current_text: fictionalStory,
        revision: 1,
      },
    });
    expect(acknowledgement?.value.client_story_id).toMatch(
      /^[0-9a-f-]{36}$/i,
    );

    persistence.close();
    persistence = createGuestPersistence({
      databaseName,
      now: () => now,
    });

    const recovered = await persistence.recoverGuestDraft();
    expect(recovered?.story.current_text).toBe(fictionalStory);
    expect(recovered?.story.revision).toBe(1);
    expect(recovered?.story.expires_at).toBe(now.getTime() + 30 * DAY_MS);
  });

  it("uses a rolling 30-day expiry and purges the full local draft", async () => {
    await persistence.saveText({
      current_text: "A fictional lighthouse keeper counted seven green boats.",
    });
    const segment = await persistence.createAudioSegment({
      media_type: "audio/webm",
    });
    await persistence.appendAudioChunk({
      client_segment_id: segment.value.client_segment_id,
      chunk_sequence_number: 1,
      blob: new Blob(["fictional-audio"], { type: "audio/webm" }),
    });

    now = new Date(now.getTime() + 29 * DAY_MS);
    await persistence.saveText({
      current_text: "A fictional lighthouse keeper counted seven green boats.",
    });

    now = new Date(now.getTime() + 29 * DAY_MS);
    await expect(persistence.purgeExpiredGuestDrafts()).resolves.toMatchObject({
      value: 0,
    });
    expect(await persistence.recoverGuestDraft()).not.toBeNull();

    now = new Date(now.getTime() + DAY_MS);
    await expect(persistence.purgeExpiredGuestDrafts()).resolves.toMatchObject({
      persisted: true,
      value: 1,
    });
    expect(await persistence.recoverGuestDraft()).toBeNull();
    await expect(
      persistence.readAudioChunks(segment.value.client_segment_id),
    ).rejects.toThrow("Audio segment was not found");
  });

  it("stores MediaRecorder chunks durably and returns them in sequence", async () => {
    const segment = await persistence.createAudioSegment({
      media_type: "audio/webm",
    });
    const clientSegmentId = segment.value.client_segment_id;

    await persistence.appendAudioChunk({
      client_segment_id: clientSegmentId,
      chunk_sequence_number: 1,
      blob: new Blob(["first"], { type: "audio/webm" }),
    });
    await expect(
      persistence.appendAudioChunk({
        client_segment_id: clientSegmentId,
        chunk_sequence_number: 3,
        blob: new Blob(["gap"], { type: "audio/webm" }),
      }),
    ).rejects.toBeInstanceOf(AudioChunkSequenceError);
    await persistence.appendAudioChunk({
      client_segment_id: clientSegmentId,
      chunk_sequence_number: 2,
      blob: new Blob(["second"], { type: "audio/webm" }),
    });

    const chunks = await persistence.readAudioChunks(clientSegmentId);
    expect(chunks.map((chunk) => chunk.chunk_sequence_number)).toEqual([1, 2]);
    expect(chunks.map((chunk) => chunk.byte_size)).toEqual([5, 6]);
    expect(chunks.every((chunk) => chunk.blob !== undefined)).toBe(true);

    const finalised = await persistence.finaliseAudioSegment({
      client_segment_id: clientSegmentId,
      duration_ms: 2_400,
    });
    expect(finalised.value).toMatchObject({
      sequence_number: 1,
      status: "finalised",
      duration_ms: 2_400,
      byte_size: 11,
      media_type: "audio/webm",
    });
    await expect(
      persistence.appendAudioChunk({
        client_segment_id: clientSegmentId,
        chunk_sequence_number: 3,
        blob: new Blob(["late"], { type: "audio/webm" }),
      }),
    ).rejects.toBeInstanceOf(ImmutableRecordError);
  });

  it("reconstructs only completed standalone recorder parts", async () => {
    const segment = await persistence.createAudioSegment({
      media_type: "audio/webm",
    });
    const clientSegmentId = segment.value.client_segment_id;
    await persistence.appendAudioChunk({
      client_segment_id: clientSegmentId,
      chunk_sequence_number: 1,
      part_sequence_number: 1,
      part_chunk_sequence_number: 1,
      part_start_offset_ms: 0,
      blob: new Blob(["part-one-a"], { type: "audio/webm" }),
    });
    await persistence.appendAudioChunk({
      client_segment_id: clientSegmentId,
      chunk_sequence_number: 2,
      part_sequence_number: 1,
      part_chunk_sequence_number: 2,
      part_start_offset_ms: 0,
      blob: new Blob(["part-one-b"], { type: "audio/webm" }),
    });
    await expect(persistence.readAudioParts(clientSegmentId)).rejects.toThrow(
      "unfinished MediaRecorder part",
    );
    await persistence.finaliseAudioPart({
      client_segment_id: clientSegmentId,
      part_sequence_number: 1,
      duration_ms: 1_000,
    });
    await persistence.appendAudioChunk({
      client_segment_id: clientSegmentId,
      chunk_sequence_number: 3,
      part_sequence_number: 2,
      part_chunk_sequence_number: 1,
      part_start_offset_ms: 1_000,
      blob: new Blob(["part-two"], { type: "audio/webm" }),
    });
    await expect(persistence.readAudioParts(clientSegmentId)).resolves.toMatchObject([
      {
        part_sequence_number: 1,
        duration_ms: 1_000,
      },
    ]);
    await persistence.finaliseAudioPart({
      client_segment_id: clientSegmentId,
      part_sequence_number: 2,
      duration_ms: 800,
    });

    const parts = await persistence.readAudioParts(clientSegmentId);
    expect(parts).toMatchObject([
      {
        id: `${clientSegmentId}:1`,
        part_sequence_number: 1,
        start_offset_ms: 0,
        duration_ms: 1_000,
        byte_size: 20,
      },
      {
        id: `${clientSegmentId}:2`,
        part_sequence_number: 2,
        start_offset_ms: 1_000,
        duration_ms: 800,
        byte_size: 8,
      },
    ]);
    await expect(
      persistence.finaliseAudioSegment({
        client_segment_id: clientSegmentId,
        duration_ms: 1_800,
      }),
    ).resolves.toMatchObject({ value: { status: "finalised" } });
  });

  it("recovers an interrupted tail from durable elapsed timing", async () => {
    const segment = await persistence.createAudioSegment({
      media_type: "audio/webm;codecs=opus",
    });
    const clientSegmentId = segment.value.client_segment_id;
    await persistence.appendAudioChunk({
      client_segment_id: clientSegmentId,
      chunk_sequence_number: 1,
      part_sequence_number: 1,
      part_chunk_sequence_number: 1,
      part_start_offset_ms: 0,
      part_elapsed_ms: 1_000,
      blob: new Blob(["completed-prefix"], { type: "audio/webm" }),
    });
    await persistence.finaliseAudioPart({
      client_segment_id: clientSegmentId,
      part_sequence_number: 1,
      duration_ms: 1_000,
    });
    await persistence.appendAudioChunk({
      client_segment_id: clientSegmentId,
      chunk_sequence_number: 2,
      part_sequence_number: 2,
      part_chunk_sequence_number: 1,
      part_start_offset_ms: 1_000,
      part_elapsed_ms: 450,
      blob: new Blob(["interrupted-tail"], { type: "audio/webm" }),
    });

    const recovered = await persistence.recoverInterruptedAudioSegment(
      clientSegmentId,
    );

    expect(recovered.value).toMatchObject({
      tail_finalised: true,
      unfinished_tail_preserved: false,
      segment: {
        status: "finalised",
        transcription_disposition: "pending",
        duration_ms: 1_450,
      },
    });
    expect(recovered.value.parts.map((part) => part.duration_ms)).toEqual([
      1_000,
      450,
    ]);
  });

  it("finalises the completed prefix while retaining an unsafe interrupted tail", async () => {
    const segment = await persistence.createAudioSegment({
      media_type: "audio/webm",
    });
    const clientSegmentId = segment.value.client_segment_id;
    await persistence.appendAudioChunk({
      client_segment_id: clientSegmentId,
      chunk_sequence_number: 1,
      part_sequence_number: 1,
      part_chunk_sequence_number: 1,
      part_start_offset_ms: 0,
      part_elapsed_ms: 1_000,
      blob: new Blob(["safe-completed-prefix"], { type: "audio/webm" }),
    });
    await persistence.finaliseAudioPart({
      client_segment_id: clientSegmentId,
      part_sequence_number: 1,
      duration_ms: 1_000,
    });
    await persistence.appendAudioChunk({
      client_segment_id: clientSegmentId,
      chunk_sequence_number: 2,
      part_sequence_number: 2,
      part_chunk_sequence_number: 1,
      part_start_offset_ms: 1_000,
      part_elapsed_ms: 4 * 60 * 1_000 + 1,
      blob: new Blob(["unsafe-interrupted-tail"], { type: "audio/webm" }),
    });

    const recovered = await persistence.recoverInterruptedAudioSegment(
      clientSegmentId,
    );

    expect(recovered.value).toMatchObject({
      tail_finalised: false,
      unfinished_tail_preserved: true,
      segment: {
        status: "finalised",
        duration_ms: 1_000,
      },
    });
    expect(recovered.value.parts).toHaveLength(1);
    expect(await persistence.readAudioChunks(clientSegmentId)).toHaveLength(2);
    expect(await persistence.readAudioParts(clientSegmentId)).toHaveLength(1);
  });

  it("keeps finalised audio when transcription is deliberately skipped", async () => {
    const segment = await persistence.createAudioSegment({
      media_type: "audio/webm",
    });
    await persistence.appendAudioChunk({
      client_segment_id: segment.value.client_segment_id,
      chunk_sequence_number: 1,
      part_elapsed_ms: 900,
      blob: new Blob(["audio-kept-without-transcript"], {
        type: "audio/webm",
      }),
    });
    await persistence.finaliseAudioSegment({
      client_segment_id: segment.value.client_segment_id,
      duration_ms: 900,
    });

    const skipped = await persistence.skipAudioTranscription({
      client_segment_id: segment.value.client_segment_id,
    });

    expect(skipped.value).toMatchObject({
      status: "finalised",
      transcription_disposition: "skipped",
      duration_ms: 900,
    });
    expect(await persistence.readAudioParts(segment.value.client_segment_id))
      .toHaveLength(1);
  });

  it("keeps the first transcript immutable without logging its content", async () => {
    const consoleSpies = [
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];
    const segment = await persistence.createAudioSegment({
      media_type: "audio/webm",
    });
    await persistence.appendAudioChunk({
      client_segment_id: segment.value.client_segment_id,
      chunk_sequence_number: 1,
      blob: new Blob(["synthetic-audio"], { type: "audio/webm" }),
    });
    await persistence.finaliseAudioSegment({
      client_segment_id: segment.value.client_segment_id,
      duration_ms: 1_200,
    });

    const input = {
      client_segment_id: segment.value.client_segment_id,
      transcript_text:
        "I, um, found a fictional blue stone beside the painted bridge.",
      uncertainties: [{ start_offset: 3, end_offset: 5 }],
      transcription_provider: "synthetic-test-provider",
      transcription_model: "synthetic-test-model",
    } as const;
    const original = await persistence.saveOriginalTranscript(input);
    const retried = await persistence.saveOriginalTranscript(input);
    expect(retried.value.client_transcript_id).toBe(
      original.value.client_transcript_id,
    );

    await expect(
      persistence.saveOriginalTranscript({
        ...input,
        transcript_text: "A rewritten fictional account.",
      }),
    ).rejects.toBeInstanceOf(ImmutableRecordError);
    expect(
      (await persistence.recoverGuestDraft())?.original_transcripts[0]
        ?.transcript_text,
    ).toBe(input.transcript_text);
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("commits transcript preservation, insertion, history, and sync state atomically", async () => {
    const initialText =
      "Before the recording, a fictional clockmaker opened the blue window.";
    const initial = await persistence.saveText({ current_text: initialText });
    if (!initial) {
      throw new Error("Synthetic test setup did not create a story.");
    }
    const segment = await persistence.createAudioSegment({
      media_type: "audio/webm",
    });
    await persistence.appendAudioChunk({
      client_segment_id: segment.value.client_segment_id,
      chunk_sequence_number: 1,
      blob: new Blob(["synthetic-atomic-audio"], { type: "audio/webm" }),
    });
    await persistence.finaliseAudioSegment({
      client_segment_id: segment.value.client_segment_id,
      duration_ms: 1_700,
    });

    const beforeApplication = await persistence.recoverGuestDraft();
    const transcriptText =
      "Um, the fictional clock chimed twice beside the painted bridge.";
    const fullyInsertedText = `${initialText}\n\n${transcriptText}`;
    const acknowledgement = await persistence.applyOriginalTranscript({
      client_segment_id: segment.value.client_segment_id,
      transcript_text: transcriptText,
      uncertainties: [{ start_ms: 0, end_ms: 280, text: "Um" }],
      transcription_provider: "synthetic-test-provider",
      transcription_model: "synthetic-test-model",
      current_text: fullyInsertedText,
      expected_revision: initial.value.revision,
    });

    expect(acknowledgement).toMatchObject({
      persisted: true,
      value: {
        story: {
          current_text: fullyInsertedText,
          revision: initial.value.revision + 1,
        },
        original_transcript: {
          transcript_text: transcriptText,
        },
        story_version: {
          version_number: 1,
          story_text: fullyInsertedText,
          reason: "transcript",
        },
        application: {
          client_segment_id: segment.value.client_segment_id,
          applied_story_revision: initial.value.revision + 1,
          payload_generation:
            (beforeApplication?.migration_outbox.payload_generation ?? 0) + 1,
        },
      },
    });

    persistence.close();
    persistence = createGuestPersistence({
      databaseName,
      now: () => now,
    });
    const recovered = await persistence.recoverGuestDraft();
    expect(recovered?.story.current_text).toBe(fullyInsertedText);
    expect(recovered?.original_transcripts).toHaveLength(1);
    expect(recovered?.story_versions).toHaveLength(1);
    expect(recovered?.transcript_applications).toHaveLength(1);
    expect(recovered?.audio_segments[0]?.transcription_disposition).toBe(
      "complete",
    );
    expect(recovered?.migration_outbox.payload_generation).toBe(
      (beforeApplication?.migration_outbox.payload_generation ?? 0) + 1,
    );
  });

  it("returns the transcript application checkpoint on an identical retry", async () => {
    const segment = await persistence.createAudioSegment({
      media_type: "audio/webm",
    });
    await persistence.appendAudioChunk({
      client_segment_id: segment.value.client_segment_id,
      chunk_sequence_number: 1,
      blob: new Blob(["synthetic-idempotent-audio"], {
        type: "audio/webm",
      }),
    });
    await persistence.finaliseAudioSegment({
      client_segment_id: segment.value.client_segment_id,
      duration_ms: 2_100,
    });

    const input = {
      client_segment_id: segment.value.client_segment_id,
      transcript_text:
        "I, um, saw a fictional violet lantern beside the empty station.",
      uncertainties: [{ start_ms: 120, end_ms: 360, text: "um" }],
      transcription_provider: "synthetic-test-provider",
      transcription_model: "synthetic-test-model",
      current_text:
        "I, um, saw a fictional violet lantern beside the empty station.",
      expected_revision: 0,
    } as const;
    const first = await persistence.applyOriginalTranscript(input);
    const firstGeneration = (
      await persistence.recoverGuestDraft()
    )?.migration_outbox.payload_generation;
    const retry = await persistence.applyOriginalTranscript(input);
    const recovered = await persistence.recoverGuestDraft();

    expect(retry.value.application.client_segment_id).toBe(
      first.value.application.client_segment_id,
    );
    expect(retry.value.original_transcript.client_transcript_id).toBe(
      first.value.original_transcript.client_transcript_id,
    );
    expect(retry.value.story_version.client_version_id).toBe(
      first.value.story_version.client_version_id,
    );
    expect(recovered?.story.current_text).toBe(input.current_text);
    expect(recovered?.original_transcripts).toHaveLength(1);
    expect(recovered?.story_versions).toHaveLength(1);
    expect(recovered?.transcript_applications).toHaveLength(1);
    expect(recovered?.migration_outbox.payload_generation).toBe(
      firstGeneration,
    );

    await expect(
      persistence.applyOriginalTranscript({
        ...input,
        current_text: `${input.current_text}\n\nA duplicate insertion.`,
      }),
    ).rejects.toBeInstanceOf(ImmutableRecordError);
    expect(
      (await persistence.recoverGuestDraft())?.story.current_text,
    ).toBe(input.current_text);
  });

  it("restores a version by appending history instead of overwriting it", async () => {
    await persistence.saveText({
      current_text: "The fictional red bicycle stood by the station.",
    });
    const firstVersion = await persistence.appendStoryVersion({
      reason: "autosave",
    });
    const beforeSecondEdit = await persistence.recoverGuestDraft();
    await persistence.saveText({
      current_text: "The fictional red bicycle stood by the quiet station.",
      expected_revision: beforeSecondEdit?.story.revision,
    });
    await persistence.appendStoryVersion({ reason: "manual-edit" });

    const restored = await persistence.restoreStoryVersion({
      client_version_id: firstVersion.value.client_version_id,
    });
    expect(restored.value.story.current_text).toBe(
      "The fictional red bicycle stood by the station.",
    );
    expect(restored.value.version).toMatchObject({
      version_number: 3,
      reason: "restore",
      restored_from_version_id: firstVersion.value.client_version_id,
    });

    const recovered = await persistence.recoverGuestDraft();
    expect(recovered?.story_versions).toHaveLength(3);
    expect(recovered?.story_versions[1]?.story_text).toBe(
      "The fictional red bicycle stood by the quiet station.",
    );
  });

  it("atomically restores externally sourced text and advances sync once", async () => {
    await persistence.saveText({
      current_text: "A fictional violin maker closed the amber workshop.",
    });
    const beforeRestore = await persistence.recoverGuestDraft();
    if (!beforeRestore) {
      throw new Error("Synthetic test setup did not create a story.");
    }
    now = new Date(now.getTime() + DAY_MS);
    const restoredText =
      "A fictional violin maker opened the amber workshop before sunrise.";
    const contentSha256 = "a".repeat(64);
    const input = {
      story_text: restoredText,
      expected_revision: beforeRestore.story.revision,
      content_sha256: contentSha256,
    } as const;

    const restored = await persistence.restoreExternalStoryText(input);

    expect(restored).toMatchObject({
      persisted: true,
      value: {
        story: {
          current_text: restoredText,
          revision: beforeRestore.story.revision + 1,
          updated_at: now.getTime(),
          expires_at: now.getTime() + 30 * DAY_MS,
        },
        version: {
          version_number: 1,
          story_text: restoredText,
          reason: "restore",
          restored_from_version_id: null,
          content_sha256: contentSha256,
        },
      },
    });
    expect(restored.value.story.current_version_id).toBe(
      restored.value.version.client_version_id,
    );

    const afterRestore = await persistence.recoverGuestDraft();
    expect(afterRestore?.story_versions).toHaveLength(1);
    expect(afterRestore?.migration_outbox.payload_generation).toBe(
      beforeRestore.migration_outbox.payload_generation + 1,
    );

    const retry = await persistence.restoreExternalStoryText(input);
    const afterRetry = await persistence.recoverGuestDraft();
    expect(retry.value.version.client_version_id).toBe(
      restored.value.version.client_version_id,
    );
    expect(retry.value.story.revision).toBe(restored.value.story.revision);
    expect(afterRetry?.story_versions).toHaveLength(1);
    expect(afterRetry?.migration_outbox.payload_generation).toBe(
      afterRestore?.migration_outbox.payload_generation,
    );
  });

  it("rejects a competing external restore at a stale revision without partial history", async () => {
    await persistence.saveText({
      current_text: "A fictional stationmaster counted three paper tickets.",
    });
    const beforeRestore = await persistence.recoverGuestDraft();
    if (!beforeRestore) {
      throw new Error("Synthetic test setup did not create a story.");
    }

    const outcomes = await Promise.allSettled([
      persistence.restoreExternalStoryText({
        story_text: "The fictional stationmaster kept the first paper ticket.",
        expected_revision: beforeRestore.story.revision,
      }),
      persistence.restoreExternalStoryText({
        story_text: "The fictional stationmaster kept the third paper ticket.",
        expected_revision: beforeRestore.story.revision,
      }),
    ]);

    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<
        Awaited<ReturnType<GuestPersistence["restoreExternalStoryText"]>>
      > => outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(StaleStoryRevisionError);

    const recovered = await persistence.recoverGuestDraft();
    expect(recovered?.story.current_text).toBe(
      fulfilled[0]?.value.value.story.current_text,
    );
    expect(recovered?.story_versions).toHaveLength(1);
    expect(recovered?.story.current_version_id).toBe(
      recovered?.story_versions[0]?.client_version_id,
    );
    expect(recovered?.migration_outbox.payload_generation).toBe(
      beforeRestore.migration_outbox.payload_generation + 1,
    );
  });

  it("records one idempotent migration receipt across retries", async () => {
    await persistence.saveText({
      current_text: "A fictional baker remembered the first winter market.",
    });
    const attempt = await persistence.beginMigration();
    const ownerId = crypto.randomUUID();
    const cloudStoryId = crypto.randomUUID();
    const migrationInput = {
      owner_id: ownerId,
      story_id: cloudStoryId,
      idempotency_key: attempt.value.idempotency_key,
      payload_generation: attempt.value.payload_generation,
      cloud_revision: 1,
      cloud_version_id: null,
    } as const;

    const first = await persistence.markMigration(migrationInput);
    const retry = await persistence.markMigration(migrationInput);

    expect(retry.value.id).toBe(first.value.id);
    expect(retry.value).toMatchObject({
      owner_id: ownerId,
      story_id: cloudStoryId,
      guest_draft_id: attempt.value.client_story_id,
      idempotency_key: attempt.value.idempotency_key,
    });
    const recovered = await persistence.recoverGuestDraft();
    expect(recovered?.migration_outbox.state).toBe("completed");
    expect(recovered?.migration_outbox.cloud_synced_generation).toBe(
      attempt.value.payload_generation,
    );
    expect(recovered?.migration_receipt?.id).toBe(first.value.id);
    expect(recovered?.has_local_changes_after_migration).toBe(false);

    await persistence.saveText({
      current_text:
        "A fictional baker remembered the first winter market and its paper lanterns.",
      expected_revision: recovered?.story.revision,
    });
    const locallyChanged = await persistence.recoverGuestDraft();
    expect(locallyChanged?.migration_outbox.state).toBe("pending");
    expect(locallyChanged?.has_local_changes_after_migration).toBe(true);

    const cloudSync = await persistence.beginCloudSync();
    expect(cloudSync.value).toMatchObject({
      owner_id: ownerId,
      story_id: cloudStoryId,
      client_story_id: attempt.value.client_story_id,
      payload_generation:
        locallyChanged?.migration_outbox.payload_generation,
    });
    const cloudAcknowledgement = await persistence.acknowledgeCloudSync({
      client_story_id: cloudSync.value.client_story_id,
      story_id: cloudSync.value.story_id,
      payload_generation: cloudSync.value.payload_generation,
      cloud_revision: 2,
      cloud_version_id: null,
    });
    expect(cloudAcknowledgement.value).toMatchObject({
      state: "completed",
      cloud_synced_generation: cloudSync.value.payload_generation,
    });

    persistence.close();
    persistence = createGuestPersistence({
      databaseName,
      now: () => now,
    });
    const afterReload = await persistence.recoverGuestDraft();
    expect(afterReload?.migration_outbox.cloud_synced_generation).toBe(
      cloudSync.value.payload_generation,
    );
    expect(afterReload?.migration_outbox.state).toBe("completed");
    expect(afterReload?.has_local_changes_after_migration).toBe(false);
  });

  it("discards only the expected active draft before a fresh capture", async () => {
    const first = await persistence.saveText({
      current_text: "A fictional gardener planted silver-coloured beans.",
    });
    expect(first).not.toBeNull();
    if (!first) {
      throw new Error("Synthetic test setup did not create a story.");
    }

    await expect(
      persistence.discardGuestDraft({
        client_story_id: crypto.randomUUID(),
      }),
    ).rejects.toThrow("active guest draft changed");
    expect(await persistence.recoverGuestDraft()).not.toBeNull();

    await expect(
      persistence.discardGuestDraft({
        client_story_id: first.value.client_story_id,
      }),
    ).resolves.toMatchObject({ persisted: true, value: true });
    expect(await persistence.recoverGuestDraft()).toBeNull();

    const fresh = await persistence.saveText({
      current_text: "A fictional potter opened a fresh canvas.",
    });
    expect(fresh?.value.client_story_id).not.toBe(
      first.value.client_story_id,
    );
  });

  it("clears an authenticated local mirror only after its exact generation is cloud-acknowledged", async () => {
    const first = await persistence.saveText({
      current_text: "A fictional watchmaker recorded the hour of a paper moon.",
    });
    if (!first) {
      throw new Error("Synthetic test setup did not create a story.");
    }

    await expect(
      persistence.clearCloudAcknowledgedStory({
        client_story_id: first.value.client_story_id,
      }),
    ).rejects.toThrow("not fully acknowledged by the cloud");

    const migration = await persistence.beginMigration();
    await persistence.markMigration({
      owner_id: crypto.randomUUID(),
      story_id: crypto.randomUUID(),
      idempotency_key: migration.value.idempotency_key,
      payload_generation: migration.value.payload_generation,
      cloud_revision: 1,
      cloud_version_id: null,
    });
    await persistence.saveText({
      current_text:
        "A fictional watchmaker recorded the hour of a paper moon and one new bell.",
    });

    await expect(
      persistence.clearCloudAcknowledgedStory({
        client_story_id: first.value.client_story_id,
      }),
    ).rejects.toThrow("not fully acknowledged by the cloud");
    expect((await persistence.recoverGuestDraft())?.story.current_text).toContain(
      "one new bell",
    );

    const cloudSync = await persistence.beginCloudSync();
    await persistence.acknowledgeCloudSync({
      client_story_id: cloudSync.value.client_story_id,
      story_id: cloudSync.value.story_id,
      payload_generation: cloudSync.value.payload_generation,
      cloud_revision: 2,
      cloud_version_id: null,
    });
    await expect(
      persistence.clearCloudAcknowledgedStory({
        client_story_id: first.value.client_story_id,
      }),
    ).resolves.toMatchObject({ persisted: true, value: true });
    expect(await persistence.recoverGuestDraft()).toBeNull();
  });

  it("does not clear a cloud-acknowledged mirror while a recording still needs attention", async () => {
    const segment = await persistence.createAudioSegment({
      media_type: "audio/webm",
    });
    const migration = await persistence.beginMigration();
    await persistence.markMigration({
      owner_id: crypto.randomUUID(),
      story_id: crypto.randomUUID(),
      idempotency_key: migration.value.idempotency_key,
      payload_generation: migration.value.payload_generation,
      cloud_revision: 1,
      cloud_version_id: null,
    });

    await expect(
      persistence.clearCloudAcknowledgedStory({
        client_story_id: segment.value.client_story_id,
      }),
    ).rejects.toThrow("not fully acknowledged by the cloud");
    expect(await persistence.recoverGuestDraft()).not.toBeNull();
  });

  it("adopts an acknowledged cloud story as the one offline local mirror", async () => {
    const ownerId = crypto.randomUUID();
    const storyId = crypto.randomUUID();
    const clientStoryId = crypto.randomUUID();
    const adopted = await persistence.adoptCloudStory({
      owner_id: ownerId,
      story_id: storyId,
      client_story_id: clientStoryId,
      title: null,
      current_text: "A fictional pilot remembered a violet paper kite.",
      cloud_revision: 3,
      cloud_version_id: null,
      captured_at: now.getTime(),
    });

    expect(adopted.value.client_story_id).toBe(clientStoryId);
    expect(await persistence.recoverGuestDraft()).toMatchObject({
      migration_outbox: {
        state: "completed",
        payload_generation: 1,
        cloud_synced_generation: 1,
      },
      migration_receipt: {
        owner_id: ownerId,
        story_id: storyId,
      },
    });

    await expect(
      persistence.adoptCloudStory({
        owner_id: ownerId,
        story_id: crypto.randomUUID(),
        client_story_id: crypto.randomUUID(),
        title: null,
        current_text: "A different fictional cloud story.",
        cloud_revision: 1,
        cloud_version_id: null,
        captured_at: now.getTime(),
      }),
    ).rejects.toThrow("safely cleared");
  });

  it("atomically rebases a conflict only while restoring a deliberate local choice", async () => {
    const baseText = "A fictional cartographer marked one amber bridge.";
    const initial = await persistence.saveText({ current_text: baseText });
    if (!initial) {
      throw new Error("Synthetic test setup did not create a story.");
    }
    const baseVersion = await persistence.ensureCurrentStoryVersion({
      reason: "cloud-sync",
    });
    const ownerId = crypto.randomUUID();
    const storyId = crypto.randomUUID();
    const migration = await persistence.beginMigration();
    await persistence.markMigration({
      owner_id: ownerId,
      story_id: storyId,
      idempotency_key: migration.value.idempotency_key,
      payload_generation: migration.value.payload_generation,
      cloud_revision: 2,
      cloud_version_id: baseVersion.value.client_version_id,
    });

    const deviceText = `${baseText} This device added a violet ferry.`;
    await persistence.saveText({ current_text: deviceText });
    const deviceVersion = await persistence.ensureCurrentStoryVersion({
      reason: "cloud-sync",
    });
    const before = await persistence.recoverGuestDraft();
    if (!before) {
      throw new Error("Synthetic conflict setup could not be recovered.");
    }
    const incumbentVersionId = crypto.randomUUID();

    const resolution = await persistence.resolveCloudStoryConflict({
      client_story_id: before.story.client_story_id,
      story_id: storyId,
      expected_story_revision: before.story.revision,
      expected_acknowledged_cloud_revision: 2,
      incumbent_cloud_revision: 3,
      incumbent_cloud_version_id: incumbentVersionId,
      selection: {
        kind: "local-version",
        client_version_id: deviceVersion.value.client_version_id,
      },
    });

    expect(resolution.value).toMatchObject({
      story: {
        current_text: deviceText,
        revision: before.story.revision + 1,
      },
      version: {
        story_text: deviceText,
        reason: "conflict-resolution",
        restored_from_version_id: deviceVersion.value.client_version_id,
      },
    });
    const recovered = await persistence.recoverGuestDraft();
    expect(recovered?.story_versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          client_version_id: baseVersion.value.client_version_id,
        }),
        expect.objectContaining({
          client_version_id: deviceVersion.value.client_version_id,
        }),
        expect.objectContaining({
          client_version_id: resolution.value.version.client_version_id,
        }),
      ]),
    );
    expect(recovered?.migration_outbox).toMatchObject({
      state: "pending",
      payload_generation: before.migration_outbox.payload_generation + 1,
      cloud_synced_generation:
        before.migration_outbox.cloud_synced_generation,
      last_acknowledged_cloud_revision: 3,
      last_acknowledged_cloud_version_id: incumbentVersionId,
      attempted_generation: null,
      last_failure_code: null,
    });
  });

  it("leaves every row unchanged when a conflict choice uses a stale cloud base", async () => {
    const local = await persistence.saveText({
      current_text: "A fictional clockmaker recorded the hour in blue ink.",
    });
    if (!local) {
      throw new Error("Synthetic test setup did not create a story.");
    }
    const version = await persistence.ensureCurrentStoryVersion({
      reason: "cloud-sync",
    });
    const storyId = crypto.randomUUID();
    const migration = await persistence.beginMigration();
    await persistence.markMigration({
      owner_id: crypto.randomUUID(),
      story_id: storyId,
      idempotency_key: migration.value.idempotency_key,
      payload_generation: migration.value.payload_generation,
      cloud_revision: 4,
      cloud_version_id: version.value.client_version_id,
    });
    await persistence.saveText({
      current_text:
        "A fictional clockmaker recorded the hour in blue ink, then closed the ledger.",
    });
    const before = await persistence.recoverGuestDraft();
    if (!before) {
      throw new Error("Synthetic conflict setup could not be recovered.");
    }

    await expect(
      persistence.resolveCloudStoryConflict({
        client_story_id: before.story.client_story_id,
        story_id: storyId,
        expected_story_revision: before.story.revision,
        expected_acknowledged_cloud_revision: 3,
        incumbent_cloud_revision: 5,
        incumbent_cloud_version_id: crypto.randomUUID(),
        selection: {
          kind: "account-version",
          story_text:
            "A fictional account copy mentioned a silver clock face.",
          cloud_version_id: crypto.randomUUID(),
        },
      }),
    ).rejects.toBeInstanceOf(MigrationConflictError);
    expect(await persistence.recoverGuestDraft()).toEqual(before);
  });

  it("atomically replaces every active row with one adopted cloud story", async () => {
    const initial = await persistence.saveText({
      current_text: "A fictional painter carried a teal umbrella to the quay.",
    });
    if (!initial) {
      throw new Error("Synthetic test setup did not create a story.");
    }
    const oldClientStoryId = initial.value.client_story_id;
    const segment = await persistence.createAudioSegment({
      media_type: "audio/webm",
    });
    await persistence.appendAudioChunk({
      client_segment_id: segment.value.client_segment_id,
      chunk_sequence_number: 1,
      blob: new Blob(["synthetic-replacement-audio"], {
        type: "audio/webm",
      }),
    });
    await persistence.finaliseAudioSegment({
      client_segment_id: segment.value.client_segment_id,
      duration_ms: 1_400,
    });
    const beforeTranscript = await persistence.recoverGuestDraft();
    await persistence.applyOriginalTranscript({
      client_segment_id: segment.value.client_segment_id,
      transcript_text: "Um, the fictional ferry carried seven yellow boxes.",
      transcription_provider: "synthetic-test-provider",
      transcription_model: "synthetic-test-model",
      current_text:
        "A fictional painter carried a teal umbrella to the quay.\n\nUm, the fictional ferry carried seven yellow boxes.",
      expected_revision: beforeTranscript?.story.revision,
    });
    const migration = await persistence.beginMigration();
    await persistence.markMigration({
      owner_id: crypto.randomUUID(),
      story_id: crypto.randomUUID(),
      idempotency_key: migration.value.idempotency_key,
      payload_generation: migration.value.payload_generation,
      cloud_revision: 1,
      cloud_version_id: null,
    });

    const ownerId = crypto.randomUUID();
    const storyId = crypto.randomUUID();
    const clientStoryId = crypto.randomUUID();
    const cloudText =
      "A fictional botanist mapped the glasshouse after the summer rain.";
    const replacement = await persistence.replaceActiveWithCloudStory({
      expected_current_client_story_id: oldClientStoryId,
      owner_id: ownerId,
      story_id: storyId,
      client_story_id: clientStoryId,
      title: "The glasshouse map",
      current_text: cloudText,
      cloud_revision: 4,
      cloud_version_id: null,
      captured_at: now.getTime() - DAY_MS,
    });

    expect(replacement.value).toMatchObject({
      client_story_id: clientStoryId,
      title: "The glasshouse map",
      current_text: cloudText,
      revision: 1,
    });
    const recovered = await persistence.recoverGuestDraft();
    expect(recovered).toMatchObject({
      story: { client_story_id: clientStoryId, current_text: cloudText },
      audio_segments: [],
      original_transcripts: [],
      transcript_applications: [],
      story_versions: [],
      migration_outbox: {
        client_story_id: clientStoryId,
        state: "completed",
        payload_generation: 1,
        cloud_synced_generation: 1,
      },
      migration_receipt: {
        owner_id: ownerId,
        story_id: storyId,
        client_story_id: clientStoryId,
      },
    });
    await expect(
      persistence.readAudioChunks(segment.value.client_segment_id),
    ).rejects.toThrow("Audio segment was not found");

    const inspection = new Dexie(databaseName);
    await inspection.open();
    const oldRowCounts = await Promise.all(
      [
        "audioChunks",
        "audioSegments",
        "originalTranscripts",
        "transcriptApplications",
        "storyVersions",
        "migrationOutbox",
        "migrationReceipts",
      ].map((tableName) =>
        inspection
          .table(tableName)
          .where("client_story_id")
          .equals(oldClientStoryId)
          .count(),
      ),
    );
    expect(oldRowCounts).toEqual([0, 0, 0, 0, 0, 0, 0]);
    await expect(inspection.table("stories").get(oldClientStoryId)).resolves.toBe(
      undefined,
    );
    inspection.close();
  });

  it("keeps the old story when guarded replacement or adopted-row creation fails", async () => {
    const initial = await persistence.saveText({
      current_text: "A fictional tailor folded a silver travelling coat.",
    });
    if (!initial) {
      throw new Error("Synthetic test setup did not create a story.");
    }
    await persistence.appendStoryVersion({ reason: "manual-edit" });
    const beforeReplacement = await persistence.recoverGuestDraft();
    if (!beforeReplacement) {
      throw new Error("Synthetic test setup could not recover the story.");
    }
    const replacement = {
      owner_id: crypto.randomUUID(),
      story_id: crypto.randomUUID(),
      client_story_id: crypto.randomUUID(),
      title: null,
      current_text: "A fictional cloud story about a green travelling trunk.",
      cloud_revision: 2,
      cloud_version_id: null,
      captured_at: now.getTime(),
    } as const;

    await expect(
      persistence.replaceActiveWithCloudStory({
        ...replacement,
        expected_current_client_story_id: crypto.randomUUID(),
      }),
    ).rejects.toThrow("active local story changed");
    expect(await persistence.recoverGuestDraft()).toEqual(beforeReplacement);

    const uuidSpy = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockImplementationOnce(() => {
        throw new Error("synthetic-adoption-write-failure");
      });
    await expect(
      persistence.replaceActiveWithCloudStory({
        ...replacement,
        expected_current_client_story_id: initial.value.client_story_id,
      }),
    ).rejects.toThrow("synthetic-adoption-write-failure");
    uuidSpy.mockRestore();

    expect(await persistence.recoverGuestDraft()).toEqual(beforeReplacement);
  });
});
