import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGuestPersistence,
  type GuestPersistence,
  type Uuid,
} from "../data";
import type {
  CloudAudioSegment,
  CloudOpenedStory,
  CloudPersistence,
  CloudStory,
  CloudStoryVersion,
} from "./cloudPersistence";
import { CloudStoryEditConflictError } from "./cloudPersistence";
import { synchroniseActiveStory } from "./storySync";

function cloudStory(
  ownerId: Uuid,
  storyId: Uuid,
  clientStoryId: Uuid,
  currentText: string,
  revision = 1,
): CloudStory {
  return {
    id: storyId,
    owner_id: ownerId,
    client_story_id: clientStoryId,
    title: null,
    current_text: currentText,
    current_version_id: null,
    revision,
    captured_at: "2026-07-19T00:00:00.000Z",
    created_at: "2026-07-19T00:00:00.000Z",
    updated_at: "2026-07-19T00:00:00.000Z",
  };
}

function acknowledgement<T>(value: T) {
  return {
    persisted: true as const,
    persistence_layer: "cloud" as const,
    acknowledged_at: Date.now(),
    value,
  };
}

function cloudAudioSegment(
  story: CloudStory,
  clientSegmentId: Uuid,
  sequenceNumber: number,
): CloudAudioSegment {
  return {
    id: clientSegmentId,
    story_id: story.id,
    owner_id: story.owner_id,
    client_segment_id: clientSegmentId,
    sequence_number: sequenceNumber,
    duration_ms: 1_200,
    recorded_at: "2026-07-19T00:00:00.000Z",
    created_at: "2026-07-19T00:00:00.000Z",
  };
}

function cloudStoryVersion(
  story: CloudStory,
  id: Uuid,
  versionNumber: number,
  reason = "manual-edit",
): CloudStoryVersion {
  return {
    id,
    story_id: story.id,
    owner_id: story.owner_id,
    version_number: versionNumber,
    story_text: story.current_text,
    reason,
    restored_from_version_id: null,
    content_sha256: null,
    created_at: "2026-07-19T00:00:00.000Z",
  };
}

function fakeCloud(
  story: CloudStory,
  existing: Partial<
    Pick<CloudOpenedStory, "audio_segments" | "versions">
  > = {},
) {
  const opened: CloudOpenedStory = {
    story,
    audio_segments: existing.audio_segments ?? [],
    audio_parts: [],
    original_transcripts: [],
    versions:
      existing.versions ?? [
        cloudStoryVersion(story, crypto.randomUUID(), 1, "guest-migration"),
      ],
    edit_conflicts: [],
  };
  const migrateGuestStory = vi.fn<CloudPersistence["migrateGuestStory"]>(() =>
      Promise.resolve(acknowledgement(story)),
    );
  const saveStoryVersion = vi.fn<CloudPersistence["saveStoryVersion"]>((input) =>
      Promise.resolve(
        acknowledgement({
          id: input.client_version_id,
          story_id: input.story_id,
          owner_id: story.owner_id,
          version_number: input.version_number,
          story_text: input.story_text,
          reason: input.reason,
          restored_from_version_id: input.restored_from_version_id ?? null,
          content_sha256: input.content_sha256 ?? null,
          created_at: "2026-07-19T00:00:00.000Z",
        }),
      ),
    );
  const updateStory = vi.fn<CloudPersistence["updateStory"]>((input) =>
      Promise.resolve(
        acknowledgement({
          ...story,
          current_text: input.current_text,
          current_version_id:
            input.current_version_id ?? story.current_version_id,
          revision: input.expected_revision + 1,
        }),
      ),
    );
  const uploadFinalisedAudio = vi.fn<
    CloudPersistence["uploadFinalisedAudio"]
  >((input) =>
    Promise.resolve(
      acknowledgement({
        segment: {
          ...cloudAudioSegment(
            story,
            input.client_segment_id,
            input.sequence_number,
          ),
          duration_ms: input.duration_ms,
        },
        parts: input.parts.map((part) => ({
          id: crypto.randomUUID(),
          audio_segment_id: input.client_segment_id,
          story_id: input.story_id,
          owner_id: story.owner_id,
          part_number: part.part_number,
          storage_object_name: `${story.owner_id}/${story.id}/${input.client_segment_id}/${part.part_number}.webm`,
          media_type: part.media_type,
          byte_size: part.audio.size,
          duration_ms: part.duration_ms,
          audio_sha256: part.audio_sha256 ?? null,
          start_offset_ms: part.start_offset_ms,
          created_at: "2026-07-19T00:00:00.000Z",
        })),
      }),
    ),
  );
  const saveOriginalTranscript =
    vi.fn<CloudPersistence["saveOriginalTranscript"]>();
  const cloud: CloudPersistence = {
    migrateGuestStory,
    uploadFinalisedAudio,
    downloadAudio: vi.fn<CloudPersistence["downloadAudio"]>(),
    saveOriginalTranscript,
    saveStoryVersion,
    updateStory,
    listStories: vi.fn<CloudPersistence["listStories"]>(() =>
      Promise.resolve([]),
    ),
    openStory: vi.fn<CloudPersistence["openStory"]>(() =>
      Promise.resolve(opened),
    ),
  };
  return {
    cloud,
    migrateGuestStory,
    uploadFinalisedAudio,
    saveOriginalTranscript,
    saveStoryVersion,
    updateStory,
  };
}

describe("story cloud synchronisation", () => {
  let databaseName: string;
  let persistence: GuestPersistence;

  beforeEach(() => {
    databaseName = `story-sync-${crypto.randomUUID()}`;
    persistence = createGuestPersistence({ databaseName });
  });

  afterEach(async () => {
    persistence.close();
    await Dexie.delete(databaseName);
  });

  it("claims one guest draft and acknowledges its exact generation", async () => {
    const text = "A fictional cartographer kept a silver compass.";
    const local = await persistence.saveText({ current_text: text });
    const localVersion = await persistence.appendStoryVersion({
      reason: "manual-edit",
    });
    if (!local) {
      throw new Error("The synthetic local story was not created.");
    }
    const ownerId = crypto.randomUUID();
    const storyId = crypto.randomUUID();
    const fake = fakeCloud(
      cloudStory(ownerId, storyId, local.value.client_story_id, text),
    );

    await expect(
      synchroniseActiveStory(persistence, fake.cloud),
    ).resolves.toMatchObject({
      storyId,
      ownerId,
      fullySynced: true,
    });
    expect(fake.migrateGuestStory).toHaveBeenCalledOnce();
    expect(fake.saveStoryVersion).toHaveBeenCalledWith(
      expect.objectContaining({ version_number: 2 }),
    );
    expect(fake.updateStory).toHaveBeenCalledWith(
      expect.objectContaining({
        current_version_id: localVersion.value.client_version_id,
      }),
    );
    expect((await persistence.recoverGuestDraft())?.migration_outbox.state).toBe(
      "completed",
    );
  });

  it("does not advertise failed empty recording rows as saved audio", async () => {
    const text = "A fictional potter described a blue paper village.";
    const local = await persistence.saveText({ current_text: text });
    if (!local) {
      throw new Error("The synthetic local story was not created.");
    }
    const emptySegment = await persistence.createAudioSegment({
      media_type: "audio/webm",
    });
    await persistence.failAudioSegment({
      client_segment_id: emptySegment.value.client_segment_id,
      failure_code: "synthetic-recorder-failure",
    });
    const fake = fakeCloud(
      cloudStory(
        crypto.randomUUID(),
        crypto.randomUUID(),
        local.value.client_story_id,
        text,
      ),
    );

    await synchroniseActiveStory(persistence, fake.cloud);

    expect(fake.migrateGuestStory).toHaveBeenCalledWith(
      expect.objectContaining({ has_audio: false }),
    );
    expect(fake.uploadFinalisedAudio).not.toHaveBeenCalled();
  });

  it("uploads finalised audio even when the user continues without a transcript", async () => {
    const text = "A fictional potter kept a violet paper lantern.";
    const local = await persistence.saveText({ current_text: text });
    if (!local) {
      throw new Error("The synthetic local story was not created.");
    }
    const segment = await persistence.createAudioSegment({
      media_type: "audio/webm",
    });
    await persistence.appendAudioChunk({
      client_segment_id: segment.value.client_segment_id,
      chunk_sequence_number: 1,
      part_elapsed_ms: 800,
      blob: new Blob(["synthetic-skipped-transcript-audio"], {
        type: "audio/webm",
      }),
    });
    await persistence.finaliseAudioSegment({
      client_segment_id: segment.value.client_segment_id,
      duration_ms: 800,
    });
    await persistence.skipAudioTranscription({
      client_segment_id: segment.value.client_segment_id,
    });
    const fake = fakeCloud(
      cloudStory(
        crypto.randomUUID(),
        crypto.randomUUID(),
        local.value.client_story_id,
        text,
      ),
    );

    await synchroniseActiveStory(persistence, fake.cloud);

    expect(fake.uploadFinalisedAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        client_segment_id: segment.value.client_segment_id,
        duration_ms: 800,
      }),
    );
    expect(fake.saveOriginalTranscript).not.toHaveBeenCalled();
  });

  it("does not reserve or upload audio when Web Crypto hashing is unavailable", async () => {
    const text = "A fictional glazier carried a blue paper window.";
    const local = await persistence.saveText({ current_text: text });
    if (!local) {
      throw new Error("The synthetic local story was not created.");
    }
    const segment = await persistence.createAudioSegment({
      media_type: "audio/webm",
    });
    await persistence.appendAudioChunk({
      client_segment_id: segment.value.client_segment_id,
      chunk_sequence_number: 1,
      part_elapsed_ms: 900,
      blob: new Blob(["synthetic-web-crypto-audio"], {
        type: "audio/webm",
      }),
    });
    await persistence.finaliseAudioSegment({
      client_segment_id: segment.value.client_segment_id,
      duration_ms: 900,
    });
    const fake = fakeCloud(
      cloudStory(
        crypto.randomUUID(),
        crypto.randomUUID(),
        local.value.client_story_id,
        text,
      ),
    );
    const secureCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", {
      randomUUID: secureCrypto.randomUUID.bind(secureCrypto),
    });

    try {
      await expect(
        synchroniseActiveStory(persistence, fake.cloud),
      ).rejects.toMatchObject({
        name: "StorySyncError",
        failureCode: "cloud-sync-failed",
      });
      expect(fake.uploadFinalisedAudio).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not rewrite a story whose current cloud version already matches", async () => {
    const text = "A fictional violin maker counted seven paper strings.";
    const local = await persistence.saveText({ current_text: text });
    const localVersion = await persistence.appendStoryVersion({
      reason: "manual-edit",
    });
    if (!local) {
      throw new Error("The synthetic local story was not created.");
    }
    const remoteStory: CloudStory = {
      ...cloudStory(
        crypto.randomUUID(),
        crypto.randomUUID(),
        local.value.client_story_id,
        text,
      ),
      current_version_id: localVersion.value.client_version_id,
    };
    const fake = fakeCloud(remoteStory, {
      versions: [
        cloudStoryVersion(
          remoteStory,
          crypto.randomUUID(),
          1,
          "guest-migration",
        ),
        cloudStoryVersion(
          remoteStory,
          localVersion.value.client_version_id,
          4,
        ),
      ],
    });

    await synchroniseActiveStory(persistence, fake.cloud);

    expect(fake.saveStoryVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        client_version_id: localVersion.value.client_version_id,
        version_number: 4,
      }),
    );
    expect(fake.updateStory).not.toHaveBeenCalled();
  });

  it("uses normal cloud sync after migration and persists the new checkpoint", async () => {
    const firstText = "A fictional gardener planted three yellow trees.";
    const local = await persistence.saveText({ current_text: firstText });
    if (!local) {
      throw new Error("The synthetic local story was not created.");
    }
    const ownerId = crypto.randomUUID();
    const storyId = crypto.randomUUID();
    const firstCloud = fakeCloud(
      cloudStory(ownerId, storyId, local.value.client_story_id, firstText),
    );
    await synchroniseActiveStory(persistence, firstCloud.cloud);

    const secondText = `${firstText} Then it rained.`;
    await persistence.saveText({ current_text: secondText });
    const nextCloud = fakeCloud(
      cloudStory(ownerId, storyId, local.value.client_story_id, firstText, 2),
    );
    const result = await synchroniseActiveStory(persistence, nextCloud.cloud);

    expect(nextCloud.updateStory).toHaveBeenCalledWith(
      expect.objectContaining({
        story_id: storyId,
        current_text: secondText,
        expected_revision: 2,
      }),
    );
    expect(result?.fullySynced).toBe(true);
    const recovered = await persistence.recoverGuestDraft();
    expect(recovered?.migration_outbox.state).toBe("completed");
    expect(recovered?.migration_outbox.cloud_synced_generation).toBe(
      recovered?.migration_outbox.payload_generation,
    );
    expect(recovered?.migration_outbox.last_acknowledged_cloud_revision).toBe(
      3,
    );
  });

  it("compares an offline edit with its durable acknowledged base, not the newly opened revision", async () => {
    const firstText = "A fictional pilot folded a silver paper map.";
    const local = await persistence.saveText({ current_text: firstText });
    if (!local) {
      throw new Error("The synthetic local story was not created.");
    }
    const ownerId = crypto.randomUUID();
    const storyId = crypto.randomUUID();
    await synchroniseActiveStory(
      persistence,
      fakeCloud(
        cloudStory(ownerId, storyId, local.value.client_story_id, firstText),
      ).cloud,
    );

    const localOfflineText = `${firstText} The harbour light was green.`;
    await persistence.saveText({ current_text: localOfflineText });
    const incumbentVersionId = crypto.randomUUID();
    const remote = {
      ...cloudStory(
        ownerId,
        storyId,
        local.value.client_story_id,
        `${firstText} Another editor noted a blue lantern.`,
        3,
      ),
      current_version_id: incumbentVersionId,
    };
    const next = fakeCloud(remote, {
      versions: [cloudStoryVersion(remote, incumbentVersionId, 3)],
    });
    next.updateStory.mockImplementation((input) =>
      Promise.reject(
        new CloudStoryEditConflictError(
          {
            id: crypto.randomUUID(),
            story_id: storyId,
            owner_id: ownerId,
            expected_revision: input.expected_revision,
            observed_revision: remote.revision,
            incumbent_version_id: incumbentVersionId,
            candidate_version_id: input.current_version_id,
            candidate_title: null,
            title_was_updated: false,
            created_at: "2026-07-19T00:00:00.000Z",
          },
          remote,
        ),
      ),
    );

    await expect(
      synchroniseActiveStory(persistence, next.cloud),
    ).rejects.toBeInstanceOf(CloudStoryEditConflictError);
    expect(next.updateStory).toHaveBeenCalledWith(
      expect.objectContaining({
        current_text: localOfflineText,
        expected_revision: 2,
      }),
    );
    const recovered = await persistence.recoverGuestDraft();
    expect(recovered?.story.current_text).toBe(localOfflineText);
    expect(recovered?.migration_outbox).toMatchObject({
      state: "pending",
      last_acknowledged_cloud_revision: 2,
    });
  });

  it("acknowledges an already-applied candidate after a lost response", async () => {
    const firstText = "A fictional navigator counted four paper stars.";
    const local = await persistence.saveText({ current_text: firstText });
    if (!local) {
      throw new Error("The synthetic local story was not created.");
    }
    const ownerId = crypto.randomUUID();
    const storyId = crypto.randomUUID();
    await synchroniseActiveStory(
      persistence,
      fakeCloud(
        cloudStory(ownerId, storyId, local.value.client_story_id, firstText),
      ).cloud,
    );

    const retryText = `${firstText} One was violet.`;
    await persistence.saveText({ current_text: retryText });
    const candidate = await persistence.ensureCurrentStoryVersion({
      reason: "cloud-sync",
    });
    const remote = {
      ...cloudStory(
        ownerId,
        storyId,
        local.value.client_story_id,
        retryText,
        3,
      ),
      current_version_id: candidate.value.client_version_id,
    };
    const retry = fakeCloud(remote, {
      versions: [
        cloudStoryVersion(remote, candidate.value.client_version_id, 3),
      ],
    });

    await expect(
      synchroniseActiveStory(persistence, retry.cloud),
    ).resolves.toMatchObject({ fullySynced: true });
    expect(retry.updateStory).not.toHaveBeenCalled();
    expect((await persistence.recoverGuestDraft())?.migration_outbox).toMatchObject({
      state: "completed",
      last_acknowledged_cloud_revision: 3,
      last_acknowledged_cloud_version_id: candidate.value.client_version_id,
    });
  });

  it("safely retries existing artefacts and allocates new positions after remote maxima", async () => {
    const text = "A fictional watchmaker catalogued the bells of an empty town.";
    const local = await persistence.saveText({ current_text: text });
    if (!local) {
      throw new Error("The synthetic local story was not created.");
    }

    const firstSegment = await persistence.createAudioSegment({
      media_type: "audio/webm",
    });
    await persistence.appendAudioChunk({
      client_segment_id: firstSegment.value.client_segment_id,
      chunk_sequence_number: 1,
      blob: new Blob(["first-synthetic-audio"], { type: "audio/webm" }),
    });
    await persistence.finaliseAudioSegment({
      client_segment_id: firstSegment.value.client_segment_id,
      duration_ms: 1_200,
    });
    const firstVersion = await persistence.appendStoryVersion({
      reason: "manual-edit",
    });

    const secondSegment = await persistence.createAudioSegment({
      media_type: "audio/webm",
    });
    await persistence.appendAudioChunk({
      client_segment_id: secondSegment.value.client_segment_id,
      chunk_sequence_number: 1,
      blob: new Blob(["second-synthetic-audio"], { type: "audio/webm" }),
    });
    await persistence.finaliseAudioSegment({
      client_segment_id: secondSegment.value.client_segment_id,
      duration_ms: 1_800,
    });
    const secondVersion = await persistence.appendStoryVersion({
      reason: "autosave",
    });

    const ownerId = crypto.randomUUID();
    const storyId = crypto.randomUUID();
    const remoteStory = cloudStory(
      ownerId,
      storyId,
      local.value.client_story_id,
      text,
    );
    const fake = fakeCloud(remoteStory, {
      audio_segments: [
        cloudAudioSegment(
          remoteStory,
          firstSegment.value.client_segment_id,
          3,
        ),
        cloudAudioSegment(remoteStory, crypto.randomUUID(), 7),
      ],
      versions: [
        cloudStoryVersion(
          remoteStory,
          crypto.randomUUID(),
          1,
          "guest-migration",
        ),
        cloudStoryVersion(
          remoteStory,
          firstVersion.value.client_version_id,
          4,
        ),
        cloudStoryVersion(remoteStory, crypto.randomUUID(), 9),
      ],
    });

    await synchroniseActiveStory(persistence, fake.cloud);

    expect(fake.uploadFinalisedAudio).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        client_segment_id: firstSegment.value.client_segment_id,
        sequence_number: 3,
      }),
    );
    expect(fake.uploadFinalisedAudio).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        client_segment_id: secondSegment.value.client_segment_id,
        sequence_number: 8,
      }),
    );
    expect(fake.saveStoryVersion).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        client_version_id: firstVersion.value.client_version_id,
        version_number: 4,
      }),
    );
    expect(fake.saveStoryVersion).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        client_version_id: secondVersion.value.client_version_id,
        version_number: 10,
      }),
    );
    expect(fake.updateStory).toHaveBeenCalledWith(
      expect.objectContaining({
        current_version_id: secondVersion.value.client_version_id,
      }),
    );
  });
});
