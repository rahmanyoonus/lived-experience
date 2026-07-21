import type {
  GuestPersistence,
  RecoveredGuestDraft,
  Uuid,
} from "../data";
import {
  CloudPersistenceError,
  type CloudAudioSegment,
  type CloudPersistence,
  type CloudStory,
  type CloudStoryVersion,
} from "./cloudPersistence";

export type StorySyncFailureCode =
  | "cloud-sync-failed"
  | "local-draft-changed"
  | "recording-not-finalised";

export class StorySyncError extends Error {
  readonly failureCode: StorySyncFailureCode;

  constructor(failureCode: StorySyncFailureCode) {
    super("The story could not be synced yet.");
    this.name = "StorySyncError";
    this.failureCode = failureCode;
  }
}

export interface StorySyncOutcome {
  readonly storyId: Uuid;
  readonly ownerId: Uuid;
  readonly acknowledgedGeneration: number;
  readonly fullySynced: boolean;
}

function failureCodeFor(error: unknown): string {
  if (error instanceof StorySyncError) {
    return error.failureCode;
  }
  if (error instanceof CloudPersistenceError) {
    return error.code.toLowerCase().replaceAll("_", "-").slice(0, 64);
  }
  return "cloud-sync-failed";
}

function requireMatchingDraft(
  recovered: RecoveredGuestDraft | null,
  clientStoryId: Uuid,
): RecoveredGuestDraft {
  if (!recovered || recovered.story.client_story_id !== clientStoryId) {
    throw new StorySyncError("local-draft-changed");
  }
  if (recovered.audio_segments.some((segment) => segment.status === "recording")) {
    throw new StorySyncError("recording-not-finalised");
  }
  return recovered;
}

async function sha256Blob(blob: Blob): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new StorySyncError("cloud-sync-failed");
  }
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function uploadArtefacts(
  persistence: GuestPersistence,
  cloud: CloudPersistence,
  recovered: RecoveredGuestDraft,
  storyId: Uuid,
  existingAudioSegments: readonly CloudAudioSegment[],
  existingVersions: readonly CloudStoryVersion[],
): Promise<Uuid | undefined> {
  const transcriptBySegment = new Map(
    recovered.original_transcripts.map((transcript) => [
      transcript.client_segment_id,
      transcript,
    ]),
  );
  const existingAudioByClientId = new Map(
    existingAudioSegments.map((segment) => [
      segment.client_segment_id,
      segment,
    ]),
  );
  let nextAudioSequence =
    existingAudioSegments.reduce(
      (maximum, segment) => Math.max(maximum, segment.sequence_number),
      0,
    ) + 1;

  for (const segment of recovered.audio_segments) {
    if (segment.status !== "finalised") {
      continue;
    }
    const existingAudio = existingAudioByClientId.get(
      segment.client_segment_id,
    );
    const sequenceNumber =
      existingAudio?.sequence_number ?? nextAudioSequence++;
    const parts = await persistence.readAudioParts(
      segment.client_segment_id,
    );
    const cloudParts = [];
    for (const part of parts) {
      cloudParts.push({
        part_number: part.part_sequence_number,
        media_type: part.media_type,
        duration_ms: part.duration_ms,
        start_offset_ms: part.start_offset_ms,
        audio: part.blob,
        audio_sha256: await sha256Blob(part.blob),
      });
    }
    await cloud.uploadFinalisedAudio({
      story_id: storyId,
      client_segment_id: segment.client_segment_id,
      sequence_number: sequenceNumber,
      duration_ms: segment.duration_ms,
      recorded_at: segment.recorded_at,
      parts: cloudParts,
    });

    const transcript = transcriptBySegment.get(segment.client_segment_id);
    if (transcript) {
      await cloud.saveOriginalTranscript({
        client_transcript_id: transcript.client_transcript_id,
        story_id: storyId,
        audio_segment_id: segment.client_segment_id,
        transcript_text: transcript.transcript_text,
        uncertainties: transcript.uncertainties,
        transcription_provider: transcript.transcription_provider,
        transcription_model: transcript.transcription_model,
        transcript_sha256: transcript.transcript_sha256,
      });
    }
  }

  const existingVersionByClientId = new Map(
    existingVersions.map((version) => [version.id, version]),
  );
  let nextVersionNumber =
    existingVersions.reduce(
      (maximum, version) => Math.max(maximum, version.version_number),
      0,
    ) + 1;
  let currentVersionId: Uuid | undefined;
  for (const version of recovered.story_versions) {
    const existingVersion = existingVersionByClientId.get(
      version.client_version_id,
    );
    const saved = await cloud.saveStoryVersion({
      client_version_id: version.client_version_id,
      story_id: storyId,
      version_number:
        existingVersion?.version_number ?? nextVersionNumber++,
      story_text: version.story_text,
      reason: version.reason,
      restored_from_version_id: version.restored_from_version_id,
      content_sha256: version.content_sha256,
    });
    if (version.client_version_id === recovered.story.current_version_id) {
      currentVersionId = saved.value.id;
    }
  }

  if (recovered.story.current_version_id !== null && !currentVersionId) {
    throw new StorySyncError("local-draft-changed");
  }
  return currentVersionId;
}

async function saveCurrentTextIfNeeded(
  cloud: CloudPersistence,
  cloudStory: CloudStory,
  recovered: RecoveredGuestDraft,
  currentVersionId: Uuid | undefined,
  expectedCloudRevision: number,
): Promise<CloudStory> {
  if (
    cloudStory.current_text === recovered.story.current_text &&
    cloudStory.title === recovered.story.title &&
    (currentVersionId === undefined ||
      cloudStory.current_version_id === currentVersionId)
  ) {
    return cloudStory;
  }

  if (currentVersionId === undefined) {
    // Every text candidate must already exist as an immutable version before a
    // compare-and-swap can promote it. This is what lets concurrent editors
    // preserve both candidates without an automatic merge or silent overwrite.
    throw new StorySyncError("local-draft-changed");
  }

  return (
    await cloud.updateStory({
      story_id: cloudStory.id,
      current_text: recovered.story.current_text,
      expected_revision: expectedCloudRevision,
      title: recovered.story.title,
      current_version_id: currentVersionId,
    })
  ).value;
}

async function claimGuestStory(
  persistence: GuestPersistence,
  cloud: CloudPersistence,
): Promise<StorySyncOutcome> {
  const attempt = (await persistence.beginMigration()).value;
  try {
    const recovered = requireMatchingDraft(
      await persistence.recoverGuestDraft(),
      attempt.client_story_id,
    );
    let cloudStory = (
      await cloud.migrateGuestStory({
        idempotency_key: attempt.idempotency_key,
        client_story_id: recovered.story.client_story_id,
        current_text: recovered.story.current_text,
        captured_at: recovered.story.captured_at,
        has_audio: recovered.audio_segments.some(
          (segment) =>
            segment.status === "finalised" && segment.byte_size > 0,
        ),
        title: recovered.story.title,
      })
    ).value;

    // An idempotent migration retry can return a story whose artefacts were
    // partly uploaded by an earlier attempt, so allocate from a fresh snapshot.
    const opened = await cloud.openStory(cloudStory.id);
    cloudStory = opened.story;
    const currentVersionId = await uploadArtefacts(
      persistence,
      cloud,
      recovered,
      cloudStory.id,
      opened.audio_segments,
      opened.versions,
    );
    cloudStory = await saveCurrentTextIfNeeded(
      cloud,
      cloudStory,
      recovered,
      currentVersionId,
      cloudStory.revision,
    );
    const receipt = (
      await persistence.markMigration({
        owner_id: cloudStory.owner_id,
        story_id: cloudStory.id,
        idempotency_key: attempt.idempotency_key,
        payload_generation: attempt.payload_generation,
        cloud_revision: cloudStory.revision,
        cloud_version_id: cloudStory.current_version_id,
      })
    ).value;
    const latest = await persistence.getMigrationOutbox();

    return {
      storyId: receipt.story_id,
      ownerId: receipt.owner_id,
      acknowledgedGeneration: receipt.migrated_generation,
      fullySynced: latest?.state === "completed",
    };
  } catch (error) {
    await persistence.failMigration({
      idempotency_key: attempt.idempotency_key,
      failure_code: failureCodeFor(error),
    });
    throw error;
  }
}

async function syncClaimedStory(
  persistence: GuestPersistence,
  cloud: CloudPersistence,
): Promise<StorySyncOutcome> {
  const attempt = (await persistence.beginCloudSync()).value;
  const outbox = await persistence.getMigrationOutbox();
  try {
    const recovered = requireMatchingDraft(
      await persistence.recoverGuestDraft(),
      attempt.client_story_id,
    );
    const opened = await cloud.openStory(attempt.story_id);
    const currentVersionId = await uploadArtefacts(
      persistence,
      cloud,
      recovered,
      attempt.story_id,
      opened.audio_segments,
      opened.versions,
    );
    const savedStory = await saveCurrentTextIfNeeded(
      cloud,
      opened.story,
      recovered,
      currentVersionId,
      attempt.last_acknowledged_cloud_revision,
    );
    const acknowledged = (
      await persistence.acknowledgeCloudSync({
        client_story_id: attempt.client_story_id,
        story_id: attempt.story_id,
        payload_generation: attempt.payload_generation,
        cloud_revision: savedStory.revision,
        cloud_version_id: savedStory.current_version_id,
      })
    ).value;

    return {
      storyId: attempt.story_id,
      ownerId: attempt.owner_id,
      acknowledgedGeneration: acknowledged.cloud_synced_generation,
      fullySynced: acknowledged.state === "completed",
    };
  } catch (error) {
    if (outbox) {
      await persistence.failMigration({
        idempotency_key: outbox.idempotency_key,
        failure_code: failureCodeFor(error),
      });
    }
    throw error;
  }
}

export async function synchroniseActiveStory(
  persistence: GuestPersistence,
  cloud: CloudPersistence,
): Promise<StorySyncOutcome | null> {
  let recovered = await persistence.recoverGuestDraft();
  if (!recovered) {
    return null;
  }
  if (
    !recovered.migration_receipt ||
    recovered.has_local_changes_after_migration
  ) {
    await persistence.ensureCurrentStoryVersion({ reason: "cloud-sync" });
    recovered = await persistence.recoverGuestDraft();
    if (!recovered) {
      throw new StorySyncError("local-draft-changed");
    }
  }
  if (!recovered.migration_receipt) {
    return claimGuestStory(persistence, cloud);
  }
  if (!recovered.has_local_changes_after_migration) {
    return {
      storyId: recovered.migration_receipt.story_id,
      ownerId: recovered.migration_receipt.owner_id,
      acknowledgedGeneration:
        recovered.migration_outbox.cloud_synced_generation,
      fullySynced: true,
    };
  }
  return syncClaimedStory(persistence, cloud);
}
