import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Uuid } from "../data/types";
import {
  CloudPersistenceError,
  createCloudPersistence,
  type CloudFailureCode,
} from "./cloudPersistence";

const OWNER_ID: Uuid = "11111111-1111-4111-8111-111111111111";
const STORY_ID: Uuid = "22222222-2222-4222-8222-222222222222";
const CLIENT_STORY_ID: Uuid = "33333333-3333-4333-8333-333333333333";
const SEGMENT_ID: Uuid = "44444444-4444-4444-8444-444444444444";
const TRANSCRIPT_ID: Uuid = "55555555-5555-4555-8555-555555555555";
const VERSION_ID: Uuid = "66666666-6666-4666-8666-666666666666";
const IDEMPOTENCY_KEY: Uuid = "77777777-7777-4777-8777-777777777777";
const RESERVATION_ID: Uuid = "88888888-8888-4888-8888-888888888888";
const PART_ID: Uuid = "99999999-9999-4999-8999-999999999999";
const CAPTURED_AT = Date.parse("2026-07-19T01:00:00.000Z");
const ACKNOWLEDGED_AT = Date.parse("2026-07-19T02:00:00.000Z");
const AUDIO_SHA256 = "a".repeat(64);
const TRANSCRIPT_SHA256 = "b".repeat(64);

interface MockResponse {
  data: unknown;
  error: unknown;
}

interface MockFilter {
  column: string;
  operator: "eq" | "in";
  value: unknown;
}

interface MockDatabaseCall {
  table: string;
  action: "select" | "insert" | "update";
  columns: string | null;
  payload: unknown;
  filters: readonly MockFilter[];
}

type DatabaseHandler = (
  call: MockDatabaseCall,
) => MockResponse | Promise<MockResponse>;

class MockQuery {
  private action: MockDatabaseCall["action"] = "select";
  private columns: string | null = null;
  private payload: unknown;
  private readonly filters: MockFilter[] = [];

  constructor(
    private readonly table: string,
    private readonly calls: MockDatabaseCall[],
    private readonly handler: DatabaseHandler,
  ) {}

  select(columns: string): this {
    this.columns = columns;
    return this;
  }

  insert(payload: unknown): this {
    this.action = "insert";
    this.payload = payload;
    return this;
  }

  update(payload: unknown): this {
    this.action = "update";
    this.payload = payload;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ column, operator: "eq", value });
    return this;
  }

  in(column: string, value: unknown): this {
    this.filters.push({ column, operator: "in", value });
    return this;
  }

  order(): this {
    return this;
  }

  maybeSingle(): this {
    return this;
  }

  overrideTypes(): this {
    return this;
  }

  then<TResult1 = MockResponse, TResult2 = never>(
    onfulfilled?:
      | ((value: MockResponse) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const call: MockDatabaseCall = {
      table: this.table,
      action: this.action,
      columns: this.columns,
      payload: this.payload,
      filters: [...this.filters],
    };
    this.calls.push(call);
    return Promise.resolve(this.handler(call)).then(onfulfilled, onrejected);
  }
}

interface MockClientOptions {
  database?: DatabaseHandler;
  rpcResponse?: MockResponse;
  rpc?: (name: string, args: unknown) => MockResponse | Promise<MockResponse>;
  userId?: Uuid | null;
  authError?: unknown;
  uploadResponse?: MockResponse;
  downloadResponse?: MockResponse;
  listResponse?: MockResponse;
  infoResponse?: MockResponse;
}

function createMockClient(options: MockClientOptions = {}) {
  const databaseCalls: MockDatabaseCall[] = [];
  const database: DatabaseHandler =
    options.database ?? (() => ({ data: null, error: null }));
  const getUser = vi.fn().mockResolvedValue({
    data: {
      user:
        options.userId === null
          ? null
          : { id: options.userId ?? OWNER_ID },
    },
    error: options.authError ?? null,
  });
  const rpc = vi.fn().mockImplementation((name: string, args: unknown) => {
    const chain = {
      single() {
        return chain;
      },
      overrideTypes() {
        return Promise.resolve(
          options.rpc
            ? options.rpc(name, args)
            : options.rpcResponse ?? { data: STORY_ID, error: null },
        );
      },
    };
    return chain;
  });
  const upload = vi
    .fn()
    .mockResolvedValue(
      options.uploadResponse ?? {
        data: { path: "stored", id: "object", fullPath: "stored" },
        error: null,
      },
    );
  const list = vi
    .fn()
    .mockResolvedValue(options.listResponse ?? { data: [], error: null });
  const info = vi.fn().mockResolvedValue(
    options.infoResponse ?? {
      data: null,
      error: { statusCode: "404", message: "Object not found" },
    },
  );
  const download = vi.fn().mockResolvedValue(
    options.downloadResponse ?? {
      data: new Blob(["synthetic-audio"], { type: "audio/webm" }),
      error: null,
    },
  );
  const storageFrom = vi
    .fn()
    .mockReturnValue({ download, info, upload, list });
  const from = vi
    .fn()
    .mockImplementation(
      (table: string) => new MockQuery(table, databaseCalls, database),
    );

  const client = {
    auth: { getUser },
    from,
    rpc,
    storage: { from: storageFrom },
  } as unknown as SupabaseClient;

  return {
    client,
    databaseCalls,
    download,
    from,
    getUser,
    info,
    list,
    rpc,
    storageFrom,
    upload,
  };
}

function storyWire(overrides: Record<string, unknown> = {}) {
  return {
    id: STORY_ID,
    owner_id: OWNER_ID,
    client_story_id: CLIENT_STORY_ID,
    title: null,
    current_text: "A clearly fictional memory.",
    current_version_id: VERSION_ID,
    revision: 1,
    captured_at: "2026-07-19T01:00:00.000Z",
    created_at: "2026-07-19T01:01:00.000Z",
    updated_at: "2026-07-19T01:01:01.000Z",
    ...overrides,
  };
}

function audioWire(overrides: Record<string, unknown> = {}) {
  return {
    id: SEGMENT_ID,
    story_id: STORY_ID,
    owner_id: OWNER_ID,
    client_segment_id: SEGMENT_ID,
    sequence_number: 1,
    duration_ms: 1_250,
    recorded_at: "2026-07-19T01:02:00.000Z",
    created_at: "2026-07-19T01:03:00.000Z",
    ...overrides,
  };
}

function audioPartWire(overrides: Record<string, unknown> = {}) {
  return {
    id: PART_ID,
    audio_segment_id: SEGMENT_ID,
    story_id: STORY_ID,
    owner_id: OWNER_ID,
    part_number: 1,
    storage_object_name: `${OWNER_ID}/${STORY_ID}/${SEGMENT_ID}/1.webm`,
    media_type: "audio/webm",
    byte_size: 4,
    duration_ms: 1_250,
    audio_sha256: AUDIO_SHA256,
    start_offset_ms: 0,
    created_at: "2026-07-19T01:03:00.000Z",
    ...overrides,
  };
}

function reservationWire(overrides: Record<string, unknown> = {}) {
  return {
    id: RESERVATION_ID,
    owner_id: OWNER_ID,
    story_id: STORY_ID,
    client_segment_id: SEGMENT_ID,
    sequence_number: 1,
    duration_ms: 1_250,
    recorded_at: "2026-07-19T01:02:00.000Z",
    part_count: 1,
    total_byte_size: 4,
    expires_at: "2026-07-19T02:02:00.000Z",
    finalised_at: null,
    created_at: "2026-07-19T01:02:01.000Z",
    ...overrides,
  };
}

function partReservationWire(overrides: Record<string, unknown> = {}) {
  return {
    ...audioPartWire(),
    reservation_id: RESERVATION_ID,
    client_segment_id: SEGMENT_ID,
    ...overrides,
  };
}

function transcriptWire(overrides: Record<string, unknown> = {}) {
  return {
    id: TRANSCRIPT_ID,
    story_id: STORY_ID,
    owner_id: OWNER_ID,
    audio_segment_id: SEGMENT_ID,
    transcript_text: "Um, this is a clearly fictional memory.",
    language_code: "en",
    uncertainties: [{ start: 4, end: 8, audioStartMs: 100, audioEndMs: 300 }],
    transcription_provider: "synthetic-provider",
    transcription_model: "synthetic-model",
    transcript_sha256: TRANSCRIPT_SHA256,
    created_at: "2026-07-19T01:04:00.000Z",
    ...overrides,
  };
}

function versionWire(overrides: Record<string, unknown> = {}) {
  return {
    id: VERSION_ID,
    story_id: STORY_ID,
    owner_id: OWNER_ID,
    version_number: 2,
    story_text: "A recoverable fictional version.",
    reason: "autosave",
    restored_from_version_id: null,
    content_sha256: "d".repeat(64),
    created_at: "2026-07-19T01:05:00.000Z",
    ...overrides,
  };
}

async function expectCloudFailure(
  promise: Promise<unknown>,
  code: CloudFailureCode,
  forbiddenText?: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof CloudPersistenceError)) {
      throw error;
    }
    expect(error.code).toBe(code);
    if (forbiddenText) {
      expect(error.message).not.toContain(forbiddenText);
    }
    return;
  }
  throw new Error(`Expected cloud failure ${code}.`);
}

function makePersistence(client: SupabaseClient) {
  return createCloudPersistence({
    client,
    now: () => new Date(ACKNOWLEDGED_AT),
  });
}

describe("Supabase cloud persistence", () => {
  it("migrates the guest base through the idempotent RPC before acknowledging", async () => {
    const mock = createMockClient({
      database: (call) =>
        call.table === "stories"
          ? { data: storyWire(), error: null }
          : { data: null, error: null },
    });
    const persistence = makePersistence(mock.client);

    const acknowledgement = await persistence.migrateGuestStory({
      idempotency_key: IDEMPOTENCY_KEY,
      client_story_id: CLIENT_STORY_ID,
      current_text: "A clearly fictional memory.",
      captured_at: CAPTURED_AT,
      has_audio: true,
      payload_sha256: "c".repeat(64),
    });

    expect(mock.getUser).toHaveBeenCalledOnce();
    expect(mock.rpc).toHaveBeenCalledWith("migrate_guest_story", {
      p_idempotency_key: IDEMPOTENCY_KEY,
      p_guest_story_id: CLIENT_STORY_ID,
      p_current_text: "A clearly fictional memory.",
      p_captured_at: "2026-07-19T01:00:00.000Z",
      p_has_audio: true,
      p_title: null,
      p_payload_sha256: "c".repeat(64),
    });
    expect(mock.rpc.mock.calls[0]?.[1]).not.toHaveProperty("owner_id");
    expect(acknowledgement).toMatchObject({
      persisted: true,
      persistence_layer: "cloud",
      acknowledged_at: ACKNOWLEDGED_AT,
      value: { id: STORY_ID, owner_id: OWNER_ID },
    });
  });

  it("does not call the migration RPC without an authenticated user", async () => {
    const mock = createMockClient({ userId: null });
    const persistence = makePersistence(mock.client);

    await expectCloudFailure(
      persistence.migrateGuestStory({
        idempotency_key: IDEMPOTENCY_KEY,
        client_story_id: CLIENT_STORY_ID,
        current_text: "A synthetic story.",
        captured_at: CAPTURED_AT,
        has_audio: false,
      }),
      "AUTH_REQUIRED",
    );
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it("uses stable audio IDs and the private owner/story/audio path", async () => {
    const audio = new Blob(["safe"], { type: "audio/webm" });
    const mock = createMockClient({
      rpc: (name) =>
        name === "reserve_audio_upload"
          ? {
              data: {
                reservation: reservationWire(),
                parts: [partReservationWire()],
              },
              error: null,
            }
          : {
              data: { segment: audioWire(), parts: [audioPartWire()] },
              error: null,
            },
    });
    const persistence = makePersistence(mock.client);

    const acknowledgement = await persistence.uploadFinalisedAudio({
      story_id: STORY_ID,
      client_segment_id: SEGMENT_ID,
      sequence_number: 1,
      duration_ms: 1_250,
      recorded_at: Date.parse("2026-07-19T01:02:00.000Z"),
      parts: [
        {
          part_number: 1,
          media_type: "audio/webm",
          duration_ms: 1_250,
          start_offset_ms: 0,
          audio,
          audio_sha256: AUDIO_SHA256,
        },
      ],
    });

    expect(mock.storageFrom).toHaveBeenCalledWith("story-audio");
    expect(mock.upload).toHaveBeenCalledWith(
      `${OWNER_ID}/${STORY_ID}/${SEGMENT_ID}/1.webm`,
      audio,
      {
        cacheControl: "31536000",
        contentType: "audio/webm",
        metadata: {
          audio_sha256: AUDIO_SHA256,
          audio_part_id: PART_ID,
          client_segment_id: SEGMENT_ID,
          part_number: "1",
        },
        upsert: false,
      },
    );
    expect(mock.rpc).toHaveBeenNthCalledWith(1, "reserve_audio_upload", {
      p_story_id: STORY_ID,
      p_client_segment_id: SEGMENT_ID,
      p_preferred_sequence_number: 1,
      p_duration_ms: 1_250,
      p_recorded_at: "2026-07-19T01:02:00.000Z",
      p_parts: [
        {
          part_number: 1,
          media_type: "audio/webm",
          byte_size: 4,
          duration_ms: 1_250,
          start_offset_ms: 0,
          audio_sha256: AUDIO_SHA256,
        },
      ],
    });
    expect(acknowledgement.value.segment.id).toBe(SEGMENT_ID);
    expect(acknowledgement.value.parts[0]?.id).toBe(PART_ID);
  });

  it("rejects a missing audio digest before reserving cloud storage", async () => {
    const mock = createMockClient();
    const persistence = makePersistence(mock.client);

    await expectCloudFailure(
      persistence.uploadFinalisedAudio({
        story_id: STORY_ID,
        client_segment_id: SEGMENT_ID,
        sequence_number: 1,
        duration_ms: 1_000,
        recorded_at: CAPTURED_AT,
        parts: [
          {
            part_number: 1,
            media_type: "audio/webm",
            duration_ms: 1_000,
            start_offset_ms: 0,
            audio: new Blob(["safe"], { type: "audio/webm" }),
            audio_sha256: undefined as unknown as string,
          },
        ],
      }),
      "INVALID_CLOUD_INPUT",
    );
    expect(mock.getUser).not.toHaveBeenCalled();
    expect(mock.rpc).not.toHaveBeenCalled();
    expect(mock.upload).not.toHaveBeenCalled();
  });

  it("rejects gaps and logical-duration mismatches before reserving storage", async () => {
    const mock = createMockClient();
    const persistence = makePersistence(mock.client);
    const base = {
      story_id: STORY_ID,
      client_segment_id: SEGMENT_ID,
      sequence_number: 1,
      recorded_at: CAPTURED_AT,
    } as const;

    await expectCloudFailure(
      persistence.uploadFinalisedAudio({
        ...base,
        duration_ms: 2_000,
        parts: [
          {
            part_number: 1,
            media_type: "audio/webm",
            duration_ms: 1_000,
            start_offset_ms: 0,
            audio: new Blob(["one"], { type: "audio/webm" }),
            audio_sha256: "1".repeat(64),
          },
          {
            part_number: 2,
            media_type: "audio/webm",
            duration_ms: 1_000,
            start_offset_ms: 1_001,
            audio: new Blob(["two"], { type: "audio/webm" }),
            audio_sha256: "2".repeat(64),
          },
        ],
      }),
      "INVALID_CLOUD_INPUT",
    );
    await expectCloudFailure(
      persistence.uploadFinalisedAudio({
        ...base,
        duration_ms: 1,
        parts: [
          {
            part_number: 1,
            media_type: "audio/webm",
            duration_ms: 1_000,
            start_offset_ms: 0,
            audio: new Blob(["one"], { type: "audio/webm" }),
            audio_sha256: "3".repeat(64),
          },
        ],
      }),
      "INVALID_CLOUD_INPUT",
    );
    expect(mock.getUser).not.toHaveBeenCalled();
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it("reconciles an immutable audio retry without overwriting the object", async () => {
    const mock = createMockClient({
      listResponse: {
        data: [
          {
            name: "1.webm",
            metadata: { size: 4, mimetype: "audio/webm" },
          },
        ],
        error: null,
      },
      infoResponse: {
        data: {
          size: 4,
          contentType: "audio/webm",
          metadata: {
            clientSegmentId: SEGMENT_ID,
            audioPartId: PART_ID,
            partNumber: "1",
            audioSha256: AUDIO_SHA256,
          },
        },
        error: null,
      },
      rpc: (name) =>
        name === "reserve_audio_upload"
          ? {
              data: {
                reservation: reservationWire(),
                parts: [partReservationWire()],
              },
              error: null,
            }
          : {
              data: { segment: audioWire(), parts: [audioPartWire()] },
              error: null,
            },
    });
    const persistence = makePersistence(mock.client);

    const acknowledgement = await persistence.uploadFinalisedAudio({
      story_id: STORY_ID,
      client_segment_id: SEGMENT_ID,
      sequence_number: 1,
      duration_ms: 1_250,
      recorded_at: Date.parse("2026-07-19T01:02:00.000Z"),
      parts: [
        {
          part_number: 1,
          media_type: "audio/webm",
          duration_ms: 1_250,
          start_offset_ms: 0,
          audio: new Blob(["safe"], { type: "audio/webm" }),
          audio_sha256: AUDIO_SHA256,
        },
      ],
    });

    expect(mock.upload).not.toHaveBeenCalled();
    expect(mock.list).toHaveBeenCalledOnce();
    expect(mock.info).toHaveBeenCalledOnce();
    expect(acknowledgement.value.parts[0]?.storage_object_name).toBe(
      `${OWNER_ID}/${STORY_ID}/${SEGMENT_ID}/1.webm`,
    );
  });

  it("reconciles an immutable upload whose acknowledgement response was lost", async () => {
    const mock = createMockClient({
      uploadResponse: {
        data: null,
        error: { statusCode: "400", message: "Object already exists" },
      },
      infoResponse: {
        data: {
          size: 4,
          contentType: "audio/webm",
          metadata: {
            clientSegmentId: SEGMENT_ID,
            audioPartId: PART_ID,
            partNumber: "1",
            audioSha256: AUDIO_SHA256,
          },
        },
        error: null,
      },
      rpc: (name) =>
        name === "reserve_audio_upload"
          ? {
              data: {
                reservation: reservationWire(),
                parts: [partReservationWire()],
              },
              error: null,
            }
          : {
              data: { segment: audioWire(), parts: [audioPartWire()] },
              error: null,
            },
    });
    const persistence = makePersistence(mock.client);

    const acknowledgement = await persistence.uploadFinalisedAudio({
      story_id: STORY_ID,
      client_segment_id: SEGMENT_ID,
      sequence_number: 1,
      duration_ms: 1_250,
      recorded_at: Date.parse("2026-07-19T01:02:00.000Z"),
      parts: [
        {
          part_number: 1,
          media_type: "audio/webm",
          duration_ms: 1_250,
          start_offset_ms: 0,
          audio: new Blob(["safe"], { type: "audio/webm" }),
          audio_sha256: AUDIO_SHA256,
        },
      ],
    });

    expect(mock.list).toHaveBeenCalledOnce();
    expect(mock.upload).toHaveBeenCalledOnce();
    expect(mock.info).toHaveBeenCalledOnce();
    expect(acknowledgement.value.parts[0]?.storage_object_name).toBe(
      `${OWNER_ID}/${STORY_ID}/${SEGMENT_ID}/1.webm`,
    );
  });

  it("downloads private audio only through the authenticated owner path", async () => {
    const audio = new Blob(["synthetic-audio"], { type: "audio/webm" });
    const mock = createMockClient({
      downloadResponse: { data: audio, error: null },
    });
    const persistence = makePersistence(mock.client);
    const path = `${OWNER_ID}/${STORY_ID}/${SEGMENT_ID}/1.webm`;

    await expect(persistence.downloadAudio(path)).resolves.toBe(audio);
    expect(mock.storageFrom).toHaveBeenCalledWith("story-audio");
    expect(mock.download).toHaveBeenCalledWith(path);

    await expectCloudFailure(
      persistence.downloadAudio(
        `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${STORY_ID}/${SEGMENT_ID}/1.webm`,
      ),
      "AUTH_REQUIRED",
    );
  });

  it("withholds acknowledgement when audio metadata is not persisted", async () => {
    const sensitiveBackendMessage = "Synthetic story content must not escape";
    const mock = createMockClient({
      rpc: (name) =>
        name === "reserve_audio_upload"
          ? {
              data: {
                reservation: reservationWire(),
                parts: [partReservationWire()],
              },
              error: null,
            }
          : {
              data: null,
              error: { code: "XX000", message: sensitiveBackendMessage },
            },
    });
    const persistence = makePersistence(mock.client);

    await expectCloudFailure(
      persistence.uploadFinalisedAudio({
        story_id: STORY_ID,
        client_segment_id: SEGMENT_ID,
        sequence_number: 1,
        duration_ms: 1_250,
        recorded_at: Date.parse("2026-07-19T01:02:00.000Z"),
        parts: [
          {
            part_number: 1,
            media_type: "audio/webm",
            duration_ms: 1_250,
            start_offset_ms: 0,
            audio: new Blob(["safe"], { type: "audio/webm" }),
            audio_sha256: AUDIO_SHA256,
          },
        ],
      }),
      "AUDIO_SAVE_FAILED",
      sensitiveBackendMessage,
    );
  });

  it("inserts an immutable original transcript using its stable client UUID", async () => {
    const mock = createMockClient({
      database: (call) =>
        call.table === "original_transcripts" && call.action === "insert"
          ? { data: transcriptWire(), error: null }
          : { data: null, error: null },
    });
    const persistence = makePersistence(mock.client);

    const acknowledgement = await persistence.saveOriginalTranscript({
      client_transcript_id: TRANSCRIPT_ID,
      story_id: STORY_ID,
      audio_segment_id: SEGMENT_ID,
      transcript_text: "Um, this is a clearly fictional memory.",
      uncertainties: [
        { start: 4, end: 8, audioStartMs: 100, audioEndMs: 300 },
      ],
      transcription_provider: "synthetic-provider",
      transcription_model: "synthetic-model",
      transcript_sha256: TRANSCRIPT_SHA256,
    });

    const insert = mock.databaseCalls.find(
      (call) =>
        call.table === "original_transcripts" && call.action === "insert",
    );
    expect(insert?.payload).toMatchObject({
      id: TRANSCRIPT_ID,
      owner_id: OWNER_ID,
      story_id: STORY_ID,
      audio_segment_id: SEGMENT_ID,
      language_code: "en",
    });
    expect(acknowledgement.value.transcript_text).toBe(
      "Um, this is a clearly fictional memory.",
    );
  });

  it("maps a missing transcript insert grant without leaking backend detail", async () => {
    const sensitiveBackendMessage = "permission detail with synthetic content";
    const mock = createMockClient({
      database: (call) =>
        call.action === "insert"
          ? {
              data: null,
              error: { code: "42501", message: sensitiveBackendMessage },
            }
          : { data: null, error: null },
    });
    const persistence = makePersistence(mock.client);

    await expectCloudFailure(
      persistence.saveOriginalTranscript({
        client_transcript_id: TRANSCRIPT_ID,
        story_id: STORY_ID,
        audio_segment_id: SEGMENT_ID,
        transcript_text: "A synthetic transcript.",
        transcription_provider: "synthetic-provider",
        transcription_model: "synthetic-model",
      }),
      "TRANSCRIPT_SAVE_FAILED",
      sensitiveBackendMessage,
    );
  });

  it("inserts a recoverable story version with its stable client UUID", async () => {
    const mock = createMockClient({
      rpcResponse: { data: versionWire(), error: null },
    });
    const persistence = makePersistence(mock.client);

    const acknowledgement = await persistence.saveStoryVersion({
      client_version_id: VERSION_ID,
      story_id: STORY_ID,
      version_number: 2,
      story_text: "A recoverable fictional version.",
      reason: "autosave",
      content_sha256: "d".repeat(64),
    });

    expect(mock.rpc).toHaveBeenCalledWith("append_story_version", {
      p_client_version_id: VERSION_ID,
      p_story_id: STORY_ID,
      p_story_text: "A recoverable fictional version.",
      p_reason: "autosave",
      p_restored_from_version_id: null,
      p_content_sha256: "d".repeat(64),
    });
    expect(acknowledgement.value.id).toBe(VERSION_ID);
  });

  it("accepts an exact story-version retry without overwriting it", async () => {
    const mock = createMockClient({
      rpcResponse: { data: versionWire(), error: null },
    });
    const persistence = makePersistence(mock.client);

    await expect(
      persistence.saveStoryVersion({
        client_version_id: VERSION_ID,
        story_id: STORY_ID,
        version_number: 2,
        story_text: "A recoverable fictional version.",
        reason: "autosave",
        content_sha256: "d".repeat(64),
      }),
    ).resolves.toMatchObject({
      persisted: true,
      value: { id: VERSION_ID, version_number: 2 },
    });
    expect(mock.rpc).toHaveBeenCalledOnce();
  });

  it("rejects a conflicting story-version retry", async () => {
    const mock = createMockClient({
      rpcResponse: {
        data: versionWire({ story_text: "Different synthetic version text." }),
        error: null,
      },
    });
    const persistence = makePersistence(mock.client);

    await expectCloudFailure(
      persistence.saveStoryVersion({
        client_version_id: VERSION_ID,
        story_id: STORY_ID,
        version_number: 2,
        story_text: "A recoverable fictional version.",
        reason: "autosave",
        content_sha256: "d".repeat(64),
      }),
      "STORY_VERSION_CONFLICT",
    );
  });

  it("updates only the owner row at the expected revision", async () => {
    const mock = createMockClient({
      rpcResponse: {
        data: {
          outcome: "updated",
          story: storyWire({
            current_text: "A revised fictional memory.",
            revision: 2,
          }),
          conflict: null,
        },
        error: null,
      },
    });
    const persistence = makePersistence(mock.client);

    const acknowledgement = await persistence.updateStory({
      story_id: STORY_ID,
      current_text: "A revised fictional memory.",
      expected_revision: 1,
      current_version_id: VERSION_ID,
    });

    expect(mock.rpc).toHaveBeenCalledWith("commit_story_edit", {
      p_story_id: STORY_ID,
      p_current_text: "A revised fictional memory.",
      p_expected_revision: 1,
      p_candidate_version_id: VERSION_ID,
      p_update_title: false,
      p_title: null,
    });
    expect(acknowledgement.value.revision).toBe(2);
  });

  it("reports a stale optimistic revision without overwriting newer text", async () => {
    const mock = createMockClient({
      rpcResponse: {
        data: {
          outcome: "conflict",
          story: storyWire({ revision: 2 }),
          conflict: {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            story_id: STORY_ID,
            owner_id: OWNER_ID,
            expected_revision: 1,
            observed_revision: 2,
            incumbent_version_id: VERSION_ID,
            candidate_version_id: TRANSCRIPT_ID,
            candidate_title: null,
            title_was_updated: false,
            created_at: "2026-07-19T01:06:00.000Z",
          },
        },
        error: null,
      },
    });
    const persistence = makePersistence(mock.client);

    await expectCloudFailure(
      persistence.updateStory({
        story_id: STORY_ID,
        current_text: "A stale synthetic edit.",
        expected_revision: 1,
        current_version_id: TRANSCRIPT_ID,
      }),
      "STALE_STORY_REVISION",
    );
  });

  it("rejects an update acknowledgement that omits the requested current version", async () => {
    const mock = createMockClient({
      rpcResponse: {
        data: {
          outcome: "updated",
          story: storyWire({
            current_text: "A revised fictional memory.",
            current_version_id: null,
            revision: 2,
          }),
          conflict: null,
        },
        error: null,
      },
    });
    const persistence = makePersistence(mock.client);

    await expectCloudFailure(
      persistence.updateStory({
        story_id: STORY_ID,
        current_text: "A revised fictional memory.",
        expected_revision: 1,
        current_version_id: VERSION_ID,
      }),
      "INVALID_CLOUD_RESPONSE",
    );
  });

  it("lists only the minimal recognition fields and summed duration", async () => {
    const mock = createMockClient({
      database: (call) => {
        if (call.table === "stories") {
          return { data: [storyWire()], error: null };
        }
        if (call.table === "audio_segments") {
          return {
            data: [
              { story_id: STORY_ID, duration_ms: 1_250 },
              { story_id: STORY_ID, duration_ms: 2_750 },
            ],
            error: null,
          };
        }
        return { data: null, error: null };
      },
    });
    const persistence = makePersistence(mock.client);

    await expect(persistence.listStories()).resolves.toEqual([
      {
        id: STORY_ID,
        title: null,
        captured_at: "2026-07-19T01:00:00.000Z",
        updated_at: "2026-07-19T01:01:01.000Z",
        excerpt: "A clearly fictional memory.",
        total_voice_duration_ms: 4_000,
      },
    ]);
  });

  it("opens one owner story with its recoverable immutable artefacts", async () => {
    const mock = createMockClient({
      database: (call) => {
        switch (call.table) {
          case "stories":
            return { data: storyWire(), error: null };
          case "audio_segments":
            return { data: [audioWire()], error: null };
          case "original_transcripts":
            return { data: [transcriptWire()], error: null };
          case "story_versions":
            return { data: [versionWire()], error: null };
          default:
            return { data: null, error: null };
        }
      },
    });
    const persistence = makePersistence(mock.client);

    await expect(persistence.openStory(STORY_ID)).resolves.toMatchObject({
      story: { id: STORY_ID, owner_id: OWNER_ID },
      audio_segments: [{ id: SEGMENT_ID, story_id: STORY_ID }],
      original_transcripts: [
        { id: TRANSCRIPT_ID, audio_segment_id: SEGMENT_ID },
      ],
      versions: [{ id: VERSION_ID, version_number: 2 }],
    });
  });
});
