import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  JsonValue,
  TranscriptUncertainty,
  Uuid,
} from "../data/types";
import { requireSupabaseClient } from "../lib/supabase";

const AUDIO_BUCKET = "story-audio";
const MAX_AUDIO_PART_BYTES = 20_000_000;
const MAX_AUDIO_PART_DURATION_MS = 4 * 60 * 1_000;
const MAX_AUDIO_PARTS = 16;
const MAX_AUDIO_DURATION_MS = 30 * 60 * 1_000;
const MAX_EXCERPT_CODE_POINTS = 180;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

const STORY_COLUMNS =
  "id,owner_id,client_story_id,title,current_text,current_version_id,revision,captured_at,created_at,updated_at";
const AUDIO_COLUMNS =
  "id,story_id,owner_id,client_segment_id,sequence_number,duration_ms,recorded_at,created_at";
const AUDIO_PART_COLUMNS =
  "id,audio_segment_id,story_id,owner_id,part_number,storage_object_name,media_type,byte_size,duration_ms,audio_sha256,start_offset_ms,created_at";
const TRANSCRIPT_COLUMNS =
  "id,story_id,owner_id,audio_segment_id,transcript_text,language_code,uncertainties,transcription_provider,transcription_model,transcript_sha256,created_at";
const VERSION_COLUMNS =
  "id,story_id,owner_id,version_number,story_text,reason,restored_from_version_id,content_sha256,created_at";
const CONFLICT_COLUMNS =
  "id,story_id,owner_id,expected_revision,observed_revision,incumbent_version_id,candidate_version_id,candidate_title,title_was_updated,created_at";

export type CloudFailureCode =
  | "CLOUD_NOT_CONFIGURED"
  | "AUTH_REQUIRED"
  | "AUTH_CHECK_FAILED"
  | "INVALID_CLOUD_INPUT"
  | "INVALID_CLOUD_RESPONSE"
  | "MIGRATION_FAILED"
  | "MIGRATION_CONFLICT"
  | "AUDIO_UPLOAD_FAILED"
  | "AUDIO_DOWNLOAD_FAILED"
  | "AUDIO_SAVE_FAILED"
  | "AUDIO_CONFLICT"
  | "AUDIO_QUOTA_NOT_CONFIGURED"
  | "AUDIO_QUOTA_EXCEEDED"
  | "AUDIO_RESERVATION_FAILED"
  | "TRANSCRIPT_SAVE_FAILED"
  | "TRANSCRIPT_CONFLICT"
  | "STORY_VERSION_SAVE_FAILED"
  | "STORY_VERSION_CONFLICT"
  | "STORY_SAVE_FAILED"
  | "STALE_STORY_REVISION"
  | "STORY_NOT_FOUND"
  | "STORY_LIST_FAILED"
  | "STORY_OPEN_FAILED";

const FAILURE_MESSAGES: Record<CloudFailureCode, string> = {
  CLOUD_NOT_CONFIGURED: "Cloud saving is not configured for this deployment.",
  AUTH_REQUIRED: "Sign in by email before saving this story to the cloud.",
  AUTH_CHECK_FAILED: "Your account could not be checked yet.",
  INVALID_CLOUD_INPUT: "The cloud save request was invalid.",
  INVALID_CLOUD_RESPONSE: "The cloud returned an invalid response.",
  MIGRATION_FAILED: "The device-only story could not be secured yet.",
  MIGRATION_CONFLICT: "This device-only story conflicts with an earlier transfer.",
  AUDIO_UPLOAD_FAILED: "The original recording could not be uploaded yet.",
  AUDIO_DOWNLOAD_FAILED: "The original recording could not be opened yet.",
  AUDIO_SAVE_FAILED: "The original recording could not be acknowledged yet.",
  AUDIO_CONFLICT: "The original recording conflicts with an existing upload.",
  AUDIO_QUOTA_NOT_CONFIGURED:
    "Cloud audio saving is not configured for this deployment.",
  AUDIO_QUOTA_EXCEEDED: "This account has reached its cloud audio allowance.",
  AUDIO_RESERVATION_FAILED: "Cloud space could not be reserved for this recording yet.",
  TRANSCRIPT_SAVE_FAILED: "The original transcript could not be saved yet.",
  TRANSCRIPT_CONFLICT: "The original transcript conflicts with an existing record.",
  STORY_VERSION_SAVE_FAILED: "The story version could not be saved yet.",
  STORY_VERSION_CONFLICT: "The story version conflicts with an existing record.",
  STORY_SAVE_FAILED: "The latest story changes could not be saved yet.",
  STALE_STORY_REVISION: "The story changed before this save was acknowledged.",
  STORY_NOT_FOUND: "The story is unavailable for this account.",
  STORY_LIST_FAILED: "Your stories could not be loaded yet.",
  STORY_OPEN_FAILED: "This story could not be opened yet.",
};

const RETRYABLE_FAILURES = new Set<CloudFailureCode>([
  "AUTH_CHECK_FAILED",
  "MIGRATION_FAILED",
  "AUDIO_UPLOAD_FAILED",
  "AUDIO_DOWNLOAD_FAILED",
  "AUDIO_SAVE_FAILED",
  "AUDIO_RESERVATION_FAILED",
  "TRANSCRIPT_SAVE_FAILED",
  "STORY_VERSION_SAVE_FAILED",
  "STORY_SAVE_FAILED",
  "STORY_LIST_FAILED",
  "STORY_OPEN_FAILED",
]);

export class CloudPersistenceError extends Error {
  readonly code: CloudFailureCode;
  readonly retryable: boolean;

  constructor(code: CloudFailureCode) {
    super(FAILURE_MESSAGES[code]);
    this.name = "CloudPersistenceError";
    this.code = code;
    this.retryable = RETRYABLE_FAILURES.has(code);
  }
}

export class CloudStoryEditConflictError extends CloudPersistenceError {
  readonly conflict: CloudStoryEditConflict;
  readonly incumbent_story: CloudStory;

  constructor(conflict: CloudStoryEditConflict, incumbentStory: CloudStory) {
    super("STALE_STORY_REVISION");
    this.name = "CloudStoryEditConflictError";
    this.conflict = conflict;
    this.incumbent_story = incumbentStory;
  }
}

export interface CloudWriteAcknowledgement<T> {
  readonly persisted: true;
  readonly persistence_layer: "cloud";
  readonly acknowledged_at: number;
  readonly value: T;
}

export interface CloudStory {
  readonly id: Uuid;
  readonly owner_id: Uuid;
  readonly client_story_id: Uuid;
  readonly title: string | null;
  readonly current_text: string;
  readonly current_version_id: Uuid | null;
  readonly revision: number;
  readonly captured_at: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CloudAudioSegment {
  readonly id: Uuid;
  readonly story_id: Uuid;
  readonly owner_id: Uuid;
  readonly client_segment_id: Uuid;
  readonly sequence_number: number;
  readonly duration_ms: number;
  readonly recorded_at: string;
  readonly created_at: string;
}

export interface CloudAudioPart {
  readonly id: Uuid;
  readonly audio_segment_id: Uuid;
  readonly owner_id: Uuid;
  readonly story_id: Uuid;
  readonly part_number: number;
  readonly storage_object_name: string;
  readonly media_type: string;
  readonly byte_size: number;
  readonly duration_ms: number;
  readonly audio_sha256: string;
  readonly start_offset_ms: number;
  readonly created_at: string;
}

export interface CloudFinalisedAudio {
  readonly segment: CloudAudioSegment;
  readonly parts: readonly CloudAudioPart[];
}

interface AudioUploadReservation {
  readonly id: Uuid;
  readonly owner_id: Uuid;
  readonly story_id: Uuid;
  readonly client_segment_id: Uuid;
  readonly sequence_number: number;
  readonly duration_ms: number;
  readonly recorded_at: string;
  readonly part_count: number;
  readonly total_byte_size: number;
  readonly expires_at: string;
  readonly finalised_at: string | null;
  readonly created_at: string;
}

interface AudioUploadPartReservation {
  readonly id: Uuid;
  readonly reservation_id: Uuid;
  readonly owner_id: Uuid;
  readonly story_id: Uuid;
  readonly client_segment_id: Uuid;
  readonly part_number: number;
  readonly storage_object_name: string;
  readonly media_type: string;
  readonly byte_size: number;
  readonly duration_ms: number;
  readonly audio_sha256: string;
  readonly start_offset_ms: number;
  readonly created_at: string;
}

export interface CloudOriginalTranscript {
  readonly id: Uuid;
  readonly story_id: Uuid;
  readonly owner_id: Uuid;
  readonly audio_segment_id: Uuid;
  readonly transcript_text: string;
  readonly language_code: "en";
  readonly uncertainties: readonly TranscriptUncertainty[];
  readonly transcription_provider: string;
  readonly transcription_model: string;
  readonly transcript_sha256: string | null;
  readonly created_at: string;
}

export interface CloudStoryVersion {
  readonly id: Uuid;
  readonly story_id: Uuid;
  readonly owner_id: Uuid;
  readonly version_number: number;
  readonly story_text: string;
  readonly reason: string;
  readonly restored_from_version_id: Uuid | null;
  readonly content_sha256: string | null;
  readonly created_at: string;
}

export interface CloudStoryEditConflict {
  readonly id: Uuid;
  readonly story_id: Uuid;
  readonly owner_id: Uuid;
  readonly expected_revision: number;
  readonly observed_revision: number;
  readonly incumbent_version_id: Uuid | null;
  readonly candidate_version_id: Uuid;
  readonly candidate_title: string | null;
  readonly title_was_updated: boolean;
  readonly created_at: string;
}

export interface CloudStorySummary {
  readonly id: Uuid;
  readonly title: string | null;
  readonly captured_at: string;
  readonly updated_at: string;
  readonly excerpt: string;
  readonly total_voice_duration_ms: number;
}

export interface CloudOpenedStory {
  readonly story: CloudStory;
  readonly audio_segments: readonly CloudAudioSegment[];
  readonly audio_parts: readonly CloudAudioPart[];
  readonly original_transcripts: readonly CloudOriginalTranscript[];
  readonly versions: readonly CloudStoryVersion[];
  readonly edit_conflicts: readonly CloudStoryEditConflict[];
}

export interface MigrateGuestStoryInput {
  readonly idempotency_key: Uuid;
  readonly client_story_id: Uuid;
  readonly current_text: string;
  readonly captured_at: number;
  readonly has_audio: boolean;
  readonly title?: string | null;
  readonly payload_sha256?: string | null;
}

export interface UploadFinalisedAudioInput {
  readonly story_id: Uuid;
  readonly client_segment_id: Uuid;
  readonly sequence_number: number;
  readonly duration_ms: number;
  readonly recorded_at: number;
  readonly parts: readonly UploadFinalisedAudioPartInput[];
}

export interface UploadFinalisedAudioPartInput {
  readonly part_number: number;
  readonly media_type: string;
  readonly duration_ms: number;
  readonly start_offset_ms: number;
  readonly audio: Blob;
  readonly audio_sha256: string;
}

interface PreparedAudioPartInput {
  readonly part_number: number;
  readonly media_type: string;
  readonly duration_ms: number;
  readonly start_offset_ms: number;
  readonly audio: Blob;
  readonly audio_sha256: string;
}

export interface SaveCloudOriginalTranscriptInput {
  readonly client_transcript_id: Uuid;
  readonly story_id: Uuid;
  readonly audio_segment_id: Uuid;
  readonly transcript_text: string;
  readonly uncertainties?: readonly TranscriptUncertainty[];
  readonly transcription_provider: string;
  readonly transcription_model: string;
  readonly transcript_sha256?: string | null;
}

export interface UpdateCloudStoryInput {
  readonly story_id: Uuid;
  readonly current_text: string;
  readonly expected_revision: number;
  readonly title?: string | null;
  readonly current_version_id: Uuid;
}

export interface SaveCloudStoryVersionInput {
  readonly client_version_id: Uuid;
  readonly story_id: Uuid;
  readonly version_number: number;
  readonly story_text: string;
  readonly reason: string;
  readonly restored_from_version_id?: Uuid | null;
  readonly content_sha256?: string | null;
}

export interface CloudPersistence {
  migrateGuestStory(
    input: MigrateGuestStoryInput,
  ): Promise<CloudWriteAcknowledgement<CloudStory>>;
  uploadFinalisedAudio(
    input: UploadFinalisedAudioInput,
  ): Promise<CloudWriteAcknowledgement<CloudFinalisedAudio>>;
  downloadAudio(storage_object_name: string): Promise<Blob>;
  saveOriginalTranscript(
    input: SaveCloudOriginalTranscriptInput,
  ): Promise<CloudWriteAcknowledgement<CloudOriginalTranscript>>;
  saveStoryVersion(
    input: SaveCloudStoryVersionInput,
  ): Promise<CloudWriteAcknowledgement<CloudStoryVersion>>;
  updateStory(
    input: UpdateCloudStoryInput,
  ): Promise<CloudWriteAcknowledgement<CloudStory>>;
  listStories(): Promise<readonly CloudStorySummary[]>;
  openStory(story_id: Uuid): Promise<CloudOpenedStory>;
}

export interface CloudPersistenceOptions {
  readonly client?: SupabaseClient;
  readonly now?: () => Date;
}

interface StoryWire {
  id: string;
  owner_id: string;
  client_story_id: string;
  title: string | null;
  current_text: string;
  current_version_id: string | null;
  revision: number | string;
  captured_at: string;
  created_at: string;
  updated_at: string;
}

interface AudioWire {
  id: string;
  story_id: string;
  owner_id: string;
  client_segment_id: string;
  sequence_number: number;
  duration_ms: number;
  recorded_at: string;
  created_at: string;
}

interface AudioPartWire {
  id: string;
  audio_segment_id: string;
  story_id: string;
  owner_id: string;
  part_number: number | string;
  storage_object_name: string;
  media_type: string;
  byte_size: number | string;
  duration_ms: number | string;
  audio_sha256: string | null;
  start_offset_ms: number | string;
  created_at: string;
}

interface TranscriptWire {
  id: string;
  story_id: string;
  owner_id: string;
  audio_segment_id: string;
  transcript_text: string;
  language_code: string;
  uncertainties: unknown;
  transcription_provider: string;
  transcription_model: string;
  transcript_sha256: string | null;
  created_at: string;
}

interface VersionWire {
  id: string;
  story_id: string;
  owner_id: string;
  version_number: number | string;
  story_text: string;
  reason: string;
  restored_from_version_id: string | null;
  content_sha256: string | null;
  created_at: string;
}

interface ReservationWire {
  id: string;
  owner_id: string;
  story_id: string;
  client_segment_id: string;
  sequence_number: number | string;
  duration_ms: number | string;
  recorded_at: string;
  part_count: number | string;
  total_byte_size: number | string;
  expires_at: string;
  finalised_at: string | null;
  created_at: string;
}

interface PartReservationWire {
  id: string;
  reservation_id: string;
  owner_id: string;
  story_id: string;
  client_segment_id: string;
  part_number: number | string;
  storage_object_name: string;
  media_type: string;
  byte_size: number | string;
  duration_ms: number | string;
  audio_sha256: string | null;
  start_offset_ms: number | string;
  created_at: string;
}

interface AudioReservationPayloadWire {
  reservation: unknown;
  parts: unknown;
}

interface FinalisedAudioWire {
  segment: unknown;
  parts: unknown;
}

interface ConflictWire {
  id: string;
  story_id: string;
  owner_id: string;
  expected_revision: number | string;
  observed_revision: number | string;
  incumbent_version_id: string | null;
  candidate_version_id: string;
  candidate_title: string | null;
  title_was_updated: boolean;
  created_at: string;
}

interface CommitStoryEditWire {
  outcome: unknown;
  conflict_id: unknown;
  conflict: unknown;
  story: unknown;
}

function fail(code: CloudFailureCode): never {
  throw new CloudPersistenceError(code);
}

function contentFreeStorageErrorCode(error: unknown): string {
  if (!isRecord(error)) {
    return "unknown";
  }
  const status = error.statusCode ?? error.status;
  const message = error.message;
  const classifiedMessage =
    typeof message === "string" && /row.level security/i.test(message)
      ? "rls"
      : typeof message === "string" && /jwt|token/i.test(message)
        ? "authentication"
        : null;
  const code = error.error ?? error.code;
  const normalisedCode =
    typeof code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(code)
      ? code.toLowerCase().replaceAll("_", "-")
      : null;
  if (
    (typeof status === "number" && Number.isInteger(status)) ||
    (typeof status === "string" && /^[0-9]{3}$/.test(status))
  ) {
    return ["http", String(status), normalisedCode, classifiedMessage]
      .filter(Boolean)
      .join("-");
  }
  if (normalisedCode) {
    return normalisedCode;
  }
  return "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

function readErrorCode(error: unknown): string | null {
  if (!isRecord(error)) {
    return null;
  }
  return typeof error.code === "string" ? error.code : null;
}

function readErrorStatus(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }
  const value = error.status ?? error.statusCode;
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && /^\d{3}$/.test(value)) {
    return Number(value);
  }
  return null;
}

function isAuthenticationError(error: unknown): boolean {
  const status = readErrorStatus(error);
  return status === 401;
}

function isRejectedAuthCheck(error: unknown): boolean {
  const status = readErrorStatus(error);
  return status === 401 || status === 403;
}

function isUuid(value: unknown): value is Uuid {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function assertUuid(value: string, field: string): asserts value is Uuid {
  if (!UUID_PATTERN.test(value)) {
    void field;
    fail("INVALID_CLOUD_INPUT");
  }
}

function parseUuid(value: unknown): Uuid {
  if (!isUuid(value)) {
    fail("INVALID_CLOUD_RESPONSE");
  }
  return value;
}

function normaliseSha256(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!SHA256_PATTERN.test(value)) {
    fail("INVALID_CLOUD_INPUT");
  }
  return value.toLowerCase();
}

function parseSha256(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("INVALID_CLOUD_RESPONSE");
  }
  return value.toLowerCase();
}

function parseRequiredSha256(value: unknown): string {
  const digest = parseSha256(value);
  if (digest === null) {
    fail("INVALID_CLOUD_RESPONSE");
  }
  return digest;
}

function assertPositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("INVALID_CLOUD_INPUT");
  }
}

function assertNonNegativeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("INVALID_CLOUD_INPUT");
  }
}

function parseNonNegativeInteger(value: unknown): number {
  const parsed =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (
    typeof parsed !== "number" ||
    !Number.isSafeInteger(parsed) ||
    parsed < 0
  ) {
    fail("INVALID_CLOUD_RESPONSE");
  }
  return parsed;
}

function parsePositiveInteger(value: unknown): number {
  const parsed = parseNonNegativeInteger(value);
  if (parsed < 1) {
    fail("INVALID_CLOUD_RESPONSE");
  }
  return parsed;
}

function toIsoTimestamp(value: number): string {
  if (!Number.isFinite(value)) {
    fail("INVALID_CLOUD_INPUT");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    fail("INVALID_CLOUD_INPUT");
  }
  return date.toISOString();
}

function parseIsoTimestamp(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail("INVALID_CLOUD_RESPONSE");
  }
  return value;
}

function sameTimestamp(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}

function normaliseMediaType(value: string): string {
  const normalised = value.trim().toLowerCase();
  if (
    normalised.length < 7 ||
    normalised.length > 255 ||
    !normalised.startsWith("audio/")
  ) {
    fail("INVALID_CLOUD_INPUT");
  }
  return normalised;
}

function extensionForMediaType(mediaType: string): string {
  const baseType = mediaType.split(";", 1)[0];
  switch (baseType) {
    case "audio/webm":
      return "webm";
    case "audio/mp4":
      return "m4a";
    case "audio/ogg":
      return "ogg";
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    default:
      fail("INVALID_CLOUD_INPUT");
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

function parseUncertainties(
  value: unknown,
): readonly TranscriptUncertainty[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => isRecord(item) && isJsonValue(item))
  ) {
    fail("INVALID_CLOUD_RESPONSE");
  }
  return value;
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseStory(wire: StoryWire): CloudStory {
  if (
    (wire.title !== null && typeof wire.title !== "string") ||
    typeof wire.current_text !== "string"
  ) {
    fail("INVALID_CLOUD_RESPONSE");
  }
  return {
    id: parseUuid(wire.id),
    owner_id: parseUuid(wire.owner_id),
    client_story_id: parseUuid(wire.client_story_id),
    title: wire.title,
    current_text: wire.current_text,
    current_version_id:
      wire.current_version_id === null
        ? null
        : parseUuid(wire.current_version_id),
    revision: parseNonNegativeInteger(wire.revision),
    captured_at: parseIsoTimestamp(wire.captured_at),
    created_at: parseIsoTimestamp(wire.created_at),
    updated_at: parseIsoTimestamp(wire.updated_at),
  };
}

function parseAudio(wire: AudioWire): CloudAudioSegment {
  return {
    id: parseUuid(wire.id),
    story_id: parseUuid(wire.story_id),
    owner_id: parseUuid(wire.owner_id),
    client_segment_id: parseUuid(wire.client_segment_id),
    sequence_number: parsePositiveInteger(wire.sequence_number),
    duration_ms: parsePositiveInteger(wire.duration_ms),
    recorded_at: parseIsoTimestamp(wire.recorded_at),
    created_at: parseIsoTimestamp(wire.created_at),
  };
}

function parseAudioPart(wire: AudioPartWire): CloudAudioPart {
  if (
    typeof wire.storage_object_name !== "string" ||
    typeof wire.media_type !== "string"
  ) {
    fail("INVALID_CLOUD_RESPONSE");
  }
  return {
    id: parseUuid(wire.id),
    audio_segment_id: parseUuid(wire.audio_segment_id),
    story_id: parseUuid(wire.story_id),
    owner_id: parseUuid(wire.owner_id),
    part_number: parsePositiveInteger(wire.part_number),
    storage_object_name: wire.storage_object_name,
    media_type: wire.media_type,
    byte_size: parsePositiveInteger(wire.byte_size),
    duration_ms: parsePositiveInteger(wire.duration_ms),
    audio_sha256: parseRequiredSha256(wire.audio_sha256),
    start_offset_ms: parseNonNegativeInteger(wire.start_offset_ms),
    created_at: parseIsoTimestamp(wire.created_at),
  };
}

function parseTranscript(wire: TranscriptWire): CloudOriginalTranscript {
  if (
    typeof wire.transcript_text !== "string" ||
    wire.language_code !== "en" ||
    typeof wire.transcription_provider !== "string" ||
    typeof wire.transcription_model !== "string"
  ) {
    fail("INVALID_CLOUD_RESPONSE");
  }
  return {
    id: parseUuid(wire.id),
    story_id: parseUuid(wire.story_id),
    owner_id: parseUuid(wire.owner_id),
    audio_segment_id: parseUuid(wire.audio_segment_id),
    transcript_text: wire.transcript_text,
    language_code: "en",
    uncertainties: parseUncertainties(wire.uncertainties),
    transcription_provider: wire.transcription_provider,
    transcription_model: wire.transcription_model,
    transcript_sha256: parseSha256(wire.transcript_sha256),
    created_at: parseIsoTimestamp(wire.created_at),
  };
}

function parseVersion(wire: VersionWire): CloudStoryVersion {
  if (typeof wire.story_text !== "string" || typeof wire.reason !== "string") {
    fail("INVALID_CLOUD_RESPONSE");
  }
  return {
    id: parseUuid(wire.id),
    story_id: parseUuid(wire.story_id),
    owner_id: parseUuid(wire.owner_id),
    version_number: parsePositiveInteger(wire.version_number),
    story_text: wire.story_text,
    reason: wire.reason,
    restored_from_version_id:
      wire.restored_from_version_id === null
        ? null
        : parseUuid(wire.restored_from_version_id),
    content_sha256: parseSha256(wire.content_sha256),
    created_at: parseIsoTimestamp(wire.created_at),
  };
}

function parseReservation(wire: ReservationWire): AudioUploadReservation {
  return {
    id: parseUuid(wire.id),
    owner_id: parseUuid(wire.owner_id),
    story_id: parseUuid(wire.story_id),
    client_segment_id: parseUuid(wire.client_segment_id),
    sequence_number: parsePositiveInteger(wire.sequence_number),
    duration_ms: parsePositiveInteger(wire.duration_ms),
    recorded_at: parseIsoTimestamp(wire.recorded_at),
    part_count: parsePositiveInteger(wire.part_count),
    total_byte_size: parsePositiveInteger(wire.total_byte_size),
    expires_at: parseIsoTimestamp(wire.expires_at),
    finalised_at:
      wire.finalised_at === null ? null : parseIsoTimestamp(wire.finalised_at),
    created_at: parseIsoTimestamp(wire.created_at),
  };
}

function parsePartReservation(
  wire: PartReservationWire,
): AudioUploadPartReservation {
  if (
    typeof wire.storage_object_name !== "string" ||
    typeof wire.media_type !== "string"
  ) {
    fail("INVALID_CLOUD_RESPONSE");
  }
  return {
    id: parseUuid(wire.id),
    reservation_id: parseUuid(wire.reservation_id),
    owner_id: parseUuid(wire.owner_id),
    story_id: parseUuid(wire.story_id),
    client_segment_id: parseUuid(wire.client_segment_id),
    part_number: parsePositiveInteger(wire.part_number),
    storage_object_name: wire.storage_object_name,
    media_type: wire.media_type,
    byte_size: parsePositiveInteger(wire.byte_size),
    duration_ms: parsePositiveInteger(wire.duration_ms),
    audio_sha256: parseRequiredSha256(wire.audio_sha256),
    start_offset_ms: parseNonNegativeInteger(wire.start_offset_ms),
    created_at: parseIsoTimestamp(wire.created_at),
  };
}

function parseConflict(wire: ConflictWire): CloudStoryEditConflict {
  if (
    (wire.candidate_title !== null &&
      typeof wire.candidate_title !== "string") ||
    typeof wire.title_was_updated !== "boolean"
  ) {
    fail("INVALID_CLOUD_RESPONSE");
  }
  return {
    id: parseUuid(wire.id),
    story_id: parseUuid(wire.story_id),
    owner_id: parseUuid(wire.owner_id),
    expected_revision: parseNonNegativeInteger(wire.expected_revision),
    observed_revision: parseNonNegativeInteger(wire.observed_revision),
    incumbent_version_id:
      wire.incumbent_version_id === null
        ? null
        : parseUuid(wire.incumbent_version_id),
    candidate_version_id: parseUuid(wire.candidate_version_id),
    candidate_title: wire.candidate_title,
    title_was_updated: wire.title_was_updated,
    created_at: parseIsoTimestamp(wire.created_at),
  };
}

function excerptFrom(text: string): string {
  return Array.from(text.trim()).slice(0, MAX_EXCERPT_CODE_POINTS).join("");
}

function audioMatches(
  actual: CloudAudioSegment,
  expected: Omit<CloudAudioSegment, "created_at">,
): boolean {
  return (
    actual.id === expected.id &&
    actual.story_id === expected.story_id &&
    actual.owner_id === expected.owner_id &&
    actual.client_segment_id === expected.client_segment_id &&
    actual.sequence_number === expected.sequence_number &&
    actual.duration_ms === expected.duration_ms &&
    sameTimestamp(actual.recorded_at, expected.recorded_at)
  );
}

function audioPartMatches(
  actual: CloudAudioPart,
  expected: Omit<CloudAudioPart, "created_at">,
): boolean {
  return (
    actual.id === expected.id &&
    actual.audio_segment_id === expected.audio_segment_id &&
    actual.story_id === expected.story_id &&
    actual.owner_id === expected.owner_id &&
    actual.part_number === expected.part_number &&
    actual.storage_object_name === expected.storage_object_name &&
    actual.media_type === expected.media_type &&
    actual.byte_size === expected.byte_size &&
    actual.duration_ms === expected.duration_ms &&
    actual.audio_sha256 === expected.audio_sha256 &&
    actual.start_offset_ms === expected.start_offset_ms
  );
}

function transcriptMatches(
  actual: CloudOriginalTranscript,
  expected: Omit<CloudOriginalTranscript, "created_at">,
): boolean {
  return (
    actual.id === expected.id &&
    actual.story_id === expected.story_id &&
    actual.owner_id === expected.owner_id &&
    actual.audio_segment_id === expected.audio_segment_id &&
    actual.transcript_text === expected.transcript_text &&
    actual.language_code === expected.language_code &&
    canonicalJson(actual.uncertainties) ===
      canonicalJson(expected.uncertainties) &&
    actual.transcription_provider === expected.transcription_provider &&
    actual.transcription_model === expected.transcription_model &&
    actual.transcript_sha256 === expected.transcript_sha256
  );
}

function storyVersionMatches(
  actual: CloudStoryVersion,
  expected: Omit<CloudStoryVersion, "created_at" | "version_number">,
): boolean {
  return (
    actual.id === expected.id &&
    actual.story_id === expected.story_id &&
    actual.owner_id === expected.owner_id &&
    actual.story_text === expected.story_text &&
    actual.reason === expected.reason &&
    actual.restored_from_version_id === expected.restored_from_version_id &&
    actual.content_sha256 === expected.content_sha256
  );
}

function prepareAudioParts(
  parts: readonly UploadFinalisedAudioPartInput[],
  logicalDurationMs: number,
): readonly PreparedAudioPartInput[] {
  if (
    !isRuntimeArray(parts) ||
    parts.length < 1 ||
    parts.length > MAX_AUDIO_PARTS
  ) {
    fail("INVALID_CLOUD_INPUT");
  }
  const prepared = parts.map((part) => {
    assertPositiveInteger(part.part_number);
    assertPositiveInteger(part.duration_ms);
    assertNonNegativeInteger(part.start_offset_ms);
    if (
      part.duration_ms > MAX_AUDIO_PART_DURATION_MS ||
      part.start_offset_ms > MAX_AUDIO_DURATION_MS ||
      !(part.audio instanceof Blob) ||
      part.audio.size < 1 ||
      part.audio.size > MAX_AUDIO_PART_BYTES
    ) {
      fail("INVALID_CLOUD_INPUT");
    }
    const audioSha256 = normaliseSha256(part.audio_sha256);
    if (audioSha256 === null) {
      fail("INVALID_CLOUD_INPUT");
    }
    return {
      part_number: part.part_number,
      media_type: normaliseMediaType(part.media_type),
      duration_ms: part.duration_ms,
      start_offset_ms: part.start_offset_ms,
      audio: part.audio,
      audio_sha256: audioSha256,
    };
  });
  prepared.sort((left, right) => left.part_number - right.part_number);
  if (
    prepared.some((part, index) => part.part_number !== index + 1)
  ) {
    fail("INVALID_CLOUD_INPUT");
  }
  let expectedStartOffsetMs = 0;
  for (const part of prepared) {
    if (part.start_offset_ms !== expectedStartOffsetMs) {
      fail("INVALID_CLOUD_INPUT");
    }
    expectedStartOffsetMs += part.duration_ms;
    if (expectedStartOffsetMs > MAX_AUDIO_DURATION_MS) {
      fail("INVALID_CLOUD_INPUT");
    }
  }
  if (expectedStartOffsetMs !== logicalDurationMs) {
    fail("INVALID_CLOUD_INPUT");
  }
  return prepared;
}

class SupabaseCloudPersistence implements CloudPersistence {
  constructor(
    private readonly client: SupabaseClient,
    private readonly now: () => Date,
  ) {}

  private acknowledge<T>(value: T): CloudWriteAcknowledgement<T> {
    const acknowledgedAt = this.now().getTime();
    if (!Number.isFinite(acknowledgedAt)) {
      fail("INVALID_CLOUD_RESPONSE");
    }
    return {
      persisted: true,
      persistence_layer: "cloud",
      acknowledged_at: acknowledgedAt,
      value,
    };
  }

  private async authenticatedOwnerId(): Promise<Uuid> {
    const { data, error } = await this.client.auth.getUser();
    if (error) {
      fail(isRejectedAuthCheck(error) ? "AUTH_REQUIRED" : "AUTH_CHECK_FAILED");
    }
    if (!data.user) {
      fail("AUTH_REQUIRED");
    }
    return parseUuid(data.user.id);
  }

  private async readStory(
    storyId: Uuid,
    failureCode: CloudFailureCode,
  ): Promise<CloudStory | null> {
    const { data, error } = await this.client
      .from("stories")
      .select(STORY_COLUMNS)
      .eq("id", storyId)
      .maybeSingle()
      .overrideTypes<StoryWire, { merge: false }>();
    if (error) {
      fail(isAuthenticationError(error) ? "AUTH_REQUIRED" : failureCode);
    }
    return data === null ? null : parseStory(data);
  }

  async migrateGuestStory(
    input: MigrateGuestStoryInput,
  ): Promise<CloudWriteAcknowledgement<CloudStory>> {
    assertUuid(input.idempotency_key, "idempotency_key");
    assertUuid(input.client_story_id, "client_story_id");
    if (
      typeof input.current_text !== "string" ||
      typeof input.has_audio !== "boolean" ||
      (input.current_text.trim().length === 0 && !input.has_audio) ||
      (input.title !== null &&
        input.title !== undefined &&
        (typeof input.title !== "string" ||
          input.title.trim().length < 1 ||
          input.title.trim().length > 160))
    ) {
      fail("INVALID_CLOUD_INPUT");
    }
    const capturedAt = toIsoTimestamp(input.captured_at);
    const payloadSha256 = normaliseSha256(input.payload_sha256);
    const ownerId = await this.authenticatedOwnerId();

    const { data, error } = await this.client
      .rpc("migrate_guest_story", {
        p_idempotency_key: input.idempotency_key,
        p_guest_story_id: input.client_story_id,
        p_current_text: input.current_text,
        p_captured_at: capturedAt,
        p_has_audio: input.has_audio,
        p_title: input.title ?? null,
        p_payload_sha256: payloadSha256,
      })
      .overrideTypes<string, { merge: false }>();
    if (error) {
      const code = readErrorCode(error);
      fail(
        isAuthenticationError(error)
          ? "AUTH_REQUIRED"
          : code === "22000" || code === "23505"
            ? "MIGRATION_CONFLICT"
            : "MIGRATION_FAILED",
      );
    }

    const storyId = parseUuid(data);
    const story = await this.readStory(storyId, "MIGRATION_FAILED");
    if (
      !story ||
      story.owner_id !== ownerId ||
      story.client_story_id !== input.client_story_id
    ) {
      fail("INVALID_CLOUD_RESPONSE");
    }
    return this.acknowledge(story);
  }

  private async reserveAudioUpload(
    input: UploadFinalisedAudioInput,
    ownerId: Uuid,
    recordedAt: string,
    preparedParts: readonly PreparedAudioPartInput[],
  ): Promise<{
    reservation: AudioUploadReservation;
    parts: readonly AudioUploadPartReservation[];
  }> {
    const { data, error } = await this.client
      .rpc("reserve_audio_upload", {
        p_story_id: input.story_id,
        p_client_segment_id: input.client_segment_id,
        p_preferred_sequence_number: input.sequence_number,
        p_duration_ms: input.duration_ms,
        p_recorded_at: recordedAt,
        p_parts: preparedParts.map((part) => ({
          part_number: part.part_number,
          media_type: part.media_type,
          byte_size: part.audio.size,
          duration_ms: part.duration_ms,
          start_offset_ms: part.start_offset_ms,
          audio_sha256: part.audio_sha256,
        })),
      })
      .single()
      .overrideTypes<AudioReservationPayloadWire, { merge: false }>();
    if (error) {
      const code = readErrorCode(error);
      fail(
        isAuthenticationError(error)
          ? "AUTH_REQUIRED"
          : code === "LEQ01"
            ? "AUDIO_QUOTA_NOT_CONFIGURED"
            : code === "LEQ02"
              ? "AUDIO_QUOTA_EXCEEDED"
              : code === "22000"
                ? "AUDIO_CONFLICT"
                : "AUDIO_RESERVATION_FAILED",
      );
    }

    if (!isRecord(data) || !isRecord(data.reservation) || !Array.isArray(data.parts)) {
      fail("INVALID_CLOUD_RESPONSE");
    }
    const reservation = parseReservation(
      data.reservation as unknown as ReservationWire,
    );
    const reservedParts = data.parts.map((part) => {
      if (!isRecord(part)) {
        fail("INVALID_CLOUD_RESPONSE");
      }
      return parsePartReservation(part as unknown as PartReservationWire);
    });
    if (
      reservation.owner_id !== ownerId ||
      reservation.story_id !== input.story_id ||
      reservation.client_segment_id !== input.client_segment_id ||
      reservation.duration_ms !== input.duration_ms ||
      !sameTimestamp(reservation.recorded_at, recordedAt) ||
      reservation.part_count !== preparedParts.length ||
      reservation.total_byte_size !==
        preparedParts.reduce((total, part) => total + part.audio.size, 0) ||
      reservedParts.length !== preparedParts.length
    ) {
      fail("INVALID_CLOUD_RESPONSE");
    }
    for (const [index, prepared] of preparedParts.entries()) {
      const reserved = reservedParts[index];
      const expectedPath = `${ownerId}/${input.story_id}/${input.client_segment_id}/${prepared.part_number}.${extensionForMediaType(prepared.media_type)}`;
      if (
        !reserved ||
        reserved.reservation_id !== reservation.id ||
        reserved.owner_id !== ownerId ||
        reserved.story_id !== input.story_id ||
        reserved.client_segment_id !== input.client_segment_id ||
        reserved.part_number !== prepared.part_number ||
        reserved.storage_object_name !== expectedPath ||
        reserved.media_type !== prepared.media_type ||
        reserved.byte_size !== prepared.audio.size ||
        reserved.duration_ms !== prepared.duration_ms ||
        reserved.audio_sha256 !== prepared.audio_sha256 ||
        reserved.start_offset_ms !== prepared.start_offset_ms
      ) {
        fail("INVALID_CLOUD_RESPONSE");
      }
    }
    return { reservation, parts: reservedParts };
  }

  private async ensureAudioObject(
    path: string,
    ownerId: Uuid,
    storyId: Uuid,
    clientSegmentId: Uuid,
    audioPartId: Uuid,
    partNumber: number,
    audio: Blob,
    mediaType: string,
    audioSha256: string,
  ): Promise<void> {
    const bucket = this.client.storage.from(AUDIO_BUCKET);
    const metadata: Record<string, string> = {
      client_segment_id: clientSegmentId,
      audio_part_id: audioPartId,
      part_number: String(partNumber),
      audio_sha256: audioSha256,
    };

    const requireMatchingObject = async (): Promise<void> => {
      const { data: existingInfo, error: infoError } = await bucket.info(path);
      if (infoError) {
        console.warn(
          `[lived-experience] storage-info:${contentFreeStorageErrorCode(infoError)}`,
        );
        fail(
          isAuthenticationError(infoError)
            ? "AUTH_REQUIRED"
            : "AUDIO_UPLOAD_FAILED",
        );
      }

      const storedMetadata: unknown = existingInfo.metadata;
      if (!isRecord(storedMetadata)) {
        fail("AUDIO_CONFLICT");
      }
      const storedClientSegmentId =
        storedMetadata.clientSegmentId ?? storedMetadata.client_segment_id;
      const storedAudioPartId =
        storedMetadata.audioPartId ?? storedMetadata.audio_part_id;
      const storedPartNumber =
        storedMetadata.partNumber ?? storedMetadata.part_number;
      const storedSha256 =
        storedMetadata.audioSha256 ?? storedMetadata.audio_sha256;
      if (
        existingInfo.size !== audio.size ||
        existingInfo.contentType !== mediaType ||
        storedClientSegmentId !== clientSegmentId ||
        storedAudioPartId !== audioPartId ||
        storedPartNumber !== String(partNumber) ||
        storedSha256 !== audioSha256
      ) {
        fail("AUDIO_CONFLICT");
      }
    };

    const prefix = `${ownerId}/${storyId}/${clientSegmentId}`;
    const fileName = path.slice(prefix.length + 1);
    const { data: files, error: listError } = await bucket.list(prefix, {
      limit: 2,
      offset: 0,
      search: fileName,
      sortBy: { column: "name", order: "asc" },
    });
    if (listError) {
      console.warn(
        `[lived-experience] storage-list:${contentFreeStorageErrorCode(listError)}`,
      );
      if (isAuthenticationError(listError)) {
        fail("AUTH_REQUIRED");
      }
    } else if (files?.some((file) => file.name === fileName)) {
      await requireMatchingObject();
      return;
    }

    const { error: uploadError } = await bucket.upload(path, audio, {
      cacheControl: "31536000",
      contentType: mediaType,
      metadata,
      upsert: false,
    });
    if (!uploadError) {
      return;
    }
    console.warn(
      `[lived-experience] storage-upload:${contentFreeStorageErrorCode(uploadError)}`,
    );
    if (isAuthenticationError(uploadError)) {
      fail("AUTH_REQUIRED");
    }
    await requireMatchingObject();
  }

  async uploadFinalisedAudio(
    input: UploadFinalisedAudioInput,
  ): Promise<CloudWriteAcknowledgement<CloudFinalisedAudio>> {
    assertUuid(input.story_id, "story_id");
    assertUuid(input.client_segment_id, "client_segment_id");
    assertPositiveInteger(input.sequence_number);
    assertPositiveInteger(input.duration_ms);
    if (input.duration_ms > MAX_AUDIO_DURATION_MS) {
      fail("INVALID_CLOUD_INPUT");
    }
    const preparedParts = prepareAudioParts(input.parts, input.duration_ms);

    const ownerId = await this.authenticatedOwnerId();
    const recordedAt = toIsoTimestamp(input.recorded_at);
    const reserved = await this.reserveAudioUpload(
      input,
      ownerId,
      recordedAt,
      preparedParts,
    );
    const expected: Omit<CloudAudioSegment, "created_at"> = {
      id: input.client_segment_id,
      story_id: input.story_id,
      owner_id: ownerId,
      client_segment_id: input.client_segment_id,
      sequence_number: reserved.reservation.sequence_number,
      duration_ms: input.duration_ms,
      recorded_at: recordedAt,
    };

    for (const [index, part] of preparedParts.entries()) {
      const partReservation = reserved.parts[index];
      if (!partReservation) {
        fail("INVALID_CLOUD_RESPONSE");
      }
      await this.ensureAudioObject(
        partReservation.storage_object_name,
        ownerId,
        input.story_id,
        input.client_segment_id,
        partReservation.id,
        part.part_number,
        part.audio,
        part.media_type,
        part.audio_sha256,
      );
    }

    const { data, error } = await this.client
      .rpc("finalise_audio_upload", {
        p_client_segment_id: input.client_segment_id,
      })
      .single()
      .overrideTypes<FinalisedAudioWire, { merge: false }>();
    if (error) {
      const code = readErrorCode(error);
      fail(
        isAuthenticationError(error)
          ? "AUTH_REQUIRED"
          : code === "LEQ03" || code === "22000"
            ? "AUDIO_CONFLICT"
            : "AUDIO_SAVE_FAILED",
      );
    }
    if (!isRecord(data) || !isRecord(data.segment) || !Array.isArray(data.parts)) {
      fail("INVALID_CLOUD_RESPONSE");
    }
    const audioSegment = parseAudio(data.segment as unknown as AudioWire);
    const audioParts = data.parts.map((part) => {
      if (!isRecord(part)) {
        fail("INVALID_CLOUD_RESPONSE");
      }
      return parseAudioPart(part as unknown as AudioPartWire);
    });

    if (
      !audioMatches(audioSegment, expected) ||
      audioParts.length !== preparedParts.length
    ) {
      fail("AUDIO_CONFLICT");
    }
    for (const [index, prepared] of preparedParts.entries()) {
      const actual = audioParts[index];
      const reservation = reserved.parts[index];
      if (
        !actual ||
        !reservation ||
        !audioPartMatches(actual, {
          id: reservation.id,
          audio_segment_id: input.client_segment_id,
          story_id: input.story_id,
          owner_id: ownerId,
          part_number: prepared.part_number,
          storage_object_name: reservation.storage_object_name,
          media_type: prepared.media_type,
          byte_size: prepared.audio.size,
          duration_ms: prepared.duration_ms,
          audio_sha256: prepared.audio_sha256,
          start_offset_ms: prepared.start_offset_ms,
        })
      ) {
        fail("AUDIO_CONFLICT");
      }
    }
    return this.acknowledge({ segment: audioSegment, parts: audioParts });
  }

  async downloadAudio(storageObjectName: string): Promise<Blob> {
    const pathParts = storageObjectName.split("/");
    const fileParts = (pathParts[3] ?? "").split(".");
    if (
      pathParts.length !== 4 ||
      !isUuid(pathParts[0]) ||
      !isUuid(pathParts[1]) ||
      !isUuid(pathParts[2]) ||
      fileParts.length !== 2 ||
      !/^(?:[1-9]|1[0-6])$/.test(fileParts[0] ?? "") ||
      !/^[a-z0-9]{1,10}$/i.test(fileParts[1] ?? "")
    ) {
      fail("INVALID_CLOUD_INPUT");
    }
    const ownerId = await this.authenticatedOwnerId();
    if (pathParts[0] !== ownerId) {
      fail("AUTH_REQUIRED");
    }
    const { data, error } = await this.client.storage
      .from(AUDIO_BUCKET)
      .download(storageObjectName);
    if (error || !(data instanceof Blob)) {
      fail(
        error && isAuthenticationError(error)
          ? "AUTH_REQUIRED"
          : "AUDIO_DOWNLOAD_FAILED",
      );
    }
    return data;
  }

  private async findTranscript(
    column: "id" | "audio_segment_id",
    value: Uuid,
  ): Promise<CloudOriginalTranscript | null> {
    const { data, error } = await this.client
      .from("original_transcripts")
      .select(TRANSCRIPT_COLUMNS)
      .eq(column, value)
      .maybeSingle()
      .overrideTypes<TranscriptWire, { merge: false }>();
    if (error) {
      fail(
        isAuthenticationError(error) ? "AUTH_REQUIRED" : "TRANSCRIPT_SAVE_FAILED",
      );
    }
    return data === null ? null : parseTranscript(data);
  }

  async saveOriginalTranscript(
    input: SaveCloudOriginalTranscriptInput,
  ): Promise<CloudWriteAcknowledgement<CloudOriginalTranscript>> {
    assertUuid(input.client_transcript_id, "client_transcript_id");
    assertUuid(input.story_id, "story_id");
    assertUuid(input.audio_segment_id, "audio_segment_id");
    if (
      typeof input.transcript_text !== "string" ||
      typeof input.transcription_provider !== "string" ||
      typeof input.transcription_model !== "string" ||
      input.transcription_provider.trim().length < 1 ||
      input.transcription_provider.trim().length > 100 ||
      input.transcription_model.trim().length < 1 ||
      input.transcription_model.trim().length > 160 ||
      !(input.uncertainties ?? []).every((item) => isJsonValue(item))
    ) {
      fail("INVALID_CLOUD_INPUT");
    }

    const ownerId = await this.authenticatedOwnerId();
    const expected: Omit<CloudOriginalTranscript, "created_at"> = {
      id: input.client_transcript_id,
      story_id: input.story_id,
      owner_id: ownerId,
      audio_segment_id: input.audio_segment_id,
      transcript_text: input.transcript_text,
      language_code: "en",
      uncertainties: input.uncertainties ?? [],
      transcription_provider: input.transcription_provider.trim(),
      transcription_model: input.transcription_model.trim(),
      transcript_sha256: normaliseSha256(input.transcript_sha256),
    };

    const { data, error } = await this.client
      .from("original_transcripts")
      .insert(expected)
      .select(TRANSCRIPT_COLUMNS)
      .maybeSingle()
      .overrideTypes<TranscriptWire, { merge: false }>();
    let transcript: CloudOriginalTranscript | null =
      data === null ? null : parseTranscript(data);
    if (error || !transcript) {
      transcript = await this.findTranscript("id", input.client_transcript_id);
      transcript ??= await this.findTranscript(
        "audio_segment_id",
        input.audio_segment_id,
      );
      if (!transcript) {
        fail(
          error && isAuthenticationError(error)
            ? "AUTH_REQUIRED"
            : "TRANSCRIPT_SAVE_FAILED",
        );
      }
    }
    if (!transcriptMatches(transcript, expected)) {
      fail("TRANSCRIPT_CONFLICT");
    }
    return this.acknowledge(transcript);
  }

  async saveStoryVersion(
    input: SaveCloudStoryVersionInput,
  ): Promise<CloudWriteAcknowledgement<CloudStoryVersion>> {
    assertUuid(input.client_version_id, "client_version_id");
    assertUuid(input.story_id, "story_id");
    assertPositiveInteger(input.version_number);
    if (
      typeof input.story_text !== "string" ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(input.reason)
    ) {
      fail("INVALID_CLOUD_INPUT");
    }
    if (input.restored_from_version_id) {
      assertUuid(input.restored_from_version_id, "restored_from_version_id");
    }

    const ownerId = await this.authenticatedOwnerId();
    const expected: Omit<
      CloudStoryVersion,
      "created_at" | "version_number"
    > = {
      id: input.client_version_id,
      story_id: input.story_id,
      owner_id: ownerId,
      story_text: input.story_text,
      reason: input.reason,
      restored_from_version_id: input.restored_from_version_id ?? null,
      content_sha256: normaliseSha256(input.content_sha256),
    };

    const { data, error } = await this.client
      .rpc("append_story_version", {
        p_client_version_id: input.client_version_id,
        p_story_id: input.story_id,
        p_story_text: input.story_text,
        p_reason: input.reason,
        p_restored_from_version_id: input.restored_from_version_id ?? null,
        p_content_sha256: expected.content_sha256,
      })
      .single()
      .overrideTypes<VersionWire, { merge: false }>();
    if (error) {
      fail(
        isAuthenticationError(error)
          ? "AUTH_REQUIRED"
          : readErrorCode(error) === "22000"
            ? "STORY_VERSION_CONFLICT"
            : "STORY_VERSION_SAVE_FAILED",
      );
    }
    if (!isRecord(data)) {
      fail("INVALID_CLOUD_RESPONSE");
    }
    const version = parseVersion(data);
    if (!storyVersionMatches(version, expected)) {
      fail("STORY_VERSION_CONFLICT");
    }
    return this.acknowledge(version);
  }

  async updateStory(
    input: UpdateCloudStoryInput,
  ): Promise<CloudWriteAcknowledgement<CloudStory>> {
    assertUuid(input.story_id, "story_id");
    assertUuid(input.current_version_id, "current_version_id");
    assertNonNegativeInteger(input.expected_revision);
    if (typeof input.current_text !== "string") {
      fail("INVALID_CLOUD_INPUT");
    }
    const ownerId = await this.authenticatedOwnerId();
    const updateTitle = Object.hasOwn(input, "title");
    let title: string | null = null;
    if (updateTitle) {
      const requestedTitle = input.title;
      if (
        requestedTitle === undefined ||
        (requestedTitle !== null &&
          (typeof requestedTitle !== "string" ||
            requestedTitle.trim().length < 1 ||
            requestedTitle.trim().length > 160))
      ) {
        fail("INVALID_CLOUD_INPUT");
      }
      title = requestedTitle === null ? null : requestedTitle.trim();
    }

    const { data, error } = await this.client
      .rpc("commit_story_edit", {
        p_story_id: input.story_id,
        p_current_text: input.current_text,
        p_expected_revision: input.expected_revision,
        p_candidate_version_id: input.current_version_id,
        p_update_title: updateTitle,
        p_title: title,
      })
      .single()
      .overrideTypes<CommitStoryEditWire, { merge: false }>();
    if (error) {
      fail(
        isAuthenticationError(error)
          ? "AUTH_REQUIRED"
          : readErrorCode(error) === "42501"
            ? "STORY_NOT_FOUND"
            : "STORY_SAVE_FAILED",
      );
    }
    if (!isRecord(data) || !isRecord(data.story)) {
      fail("INVALID_CLOUD_RESPONSE");
    }

    const story = parseStory(data.story as unknown as StoryWire);
    if (data.outcome === "conflict") {
      if (!isRecord(data.conflict)) {
        fail("INVALID_CLOUD_RESPONSE");
      }
      const conflict = parseConflict(data.conflict as unknown as ConflictWire);
      if (
        conflict.story_id !== input.story_id ||
        conflict.owner_id !== ownerId ||
        conflict.expected_revision !== input.expected_revision ||
        conflict.observed_revision !== story.revision ||
        conflict.incumbent_version_id !== story.current_version_id ||
        conflict.candidate_version_id !== input.current_version_id
      ) {
        fail("INVALID_CLOUD_RESPONSE");
      }
      throw new CloudStoryEditConflictError(conflict, story);
    }
    if (data.outcome !== "updated" && data.outcome !== "already-applied") {
      fail("INVALID_CLOUD_RESPONSE");
    }

    if (
      story.owner_id !== ownerId ||
      story.current_text !== input.current_text ||
      story.current_version_id !== input.current_version_id ||
      (data.outcome === "updated" &&
        story.revision !== input.expected_revision + 1) ||
      (updateTitle && story.title !== title)
    ) {
      fail("INVALID_CLOUD_RESPONSE");
    }
    return this.acknowledge(story);
  }

  async listStories(): Promise<readonly CloudStorySummary[]> {
    const ownerId = await this.authenticatedOwnerId();
    const { data: storyRows, error: storiesError } = await this.client
      .from("stories")
      .select(STORY_COLUMNS)
      .order("captured_at", { ascending: false })
      .overrideTypes<StoryWire[], { merge: false }>();
    if (storiesError) {
      fail(
        isAuthenticationError(storiesError)
          ? "AUTH_REQUIRED"
          : "STORY_LIST_FAILED",
      );
    }
    const stories = (storyRows ?? []).map(parseStory);
    if (stories.length === 0) {
      return [];
    }

    const storyIds = stories.map((story) => story.id);
    const { data: audioRows, error: audioError } = await this.client
      .from("audio_segments")
      .select("story_id,duration_ms")
      .in("story_id", storyIds)
      .overrideTypes<
        Array<{ story_id: string; duration_ms: number }>,
        { merge: false }
      >();
    if (audioError) {
      fail(
        isAuthenticationError(audioError) ? "AUTH_REQUIRED" : "STORY_LIST_FAILED",
      );
    }

    const durationByStory = new Map<Uuid, number>();
    for (const row of audioRows ?? []) {
      const storyId = parseUuid(row.story_id);
      const duration = parsePositiveInteger(row.duration_ms);
      durationByStory.set(storyId, (durationByStory.get(storyId) ?? 0) + duration);
    }

    if (stories.some((story) => story.owner_id !== ownerId)) {
      fail("INVALID_CLOUD_RESPONSE");
    }

    return stories.map((story) => ({
      id: story.id,
      title: story.title,
      captured_at: story.captured_at,
      updated_at: story.updated_at,
      excerpt: excerptFrom(story.current_text),
      total_voice_duration_ms: durationByStory.get(story.id) ?? 0,
    }));
  }

  async openStory(storyId: Uuid): Promise<CloudOpenedStory> {
    assertUuid(storyId, "story_id");
    const ownerId = await this.authenticatedOwnerId();
    const story = await this.readStory(storyId, "STORY_OPEN_FAILED");
    if (!story) {
      fail("STORY_NOT_FOUND");
    }
    if (story.owner_id !== ownerId) {
      fail("INVALID_CLOUD_RESPONSE");
    }

    const { data: audioRows, error: audioError } = await this.client
      .from("audio_segments")
      .select(AUDIO_COLUMNS)
      .eq("story_id", storyId)
      .order("sequence_number", { ascending: true })
      .overrideTypes<AudioWire[], { merge: false }>();
    const { data: audioPartRows, error: audioPartError } = await this.client
      .from("audio_segment_parts")
      .select(AUDIO_PART_COLUMNS)
      .eq("story_id", storyId)
      .order("part_number", { ascending: true })
      .overrideTypes<AudioPartWire[], { merge: false }>();
    const { data: transcriptRows, error: transcriptError } = await this.client
      .from("original_transcripts")
      .select(TRANSCRIPT_COLUMNS)
      .eq("story_id", storyId)
      .order("created_at", { ascending: true })
      .overrideTypes<TranscriptWire[], { merge: false }>();
    const { data: versionRows, error: versionError } = await this.client
      .from("story_versions")
      .select(VERSION_COLUMNS)
      .eq("story_id", storyId)
      .order("version_number", { ascending: false })
      .overrideTypes<VersionWire[], { merge: false }>();
    const { data: conflictRows, error: conflictError } = await this.client
      .from("story_edit_conflicts")
      .select(CONFLICT_COLUMNS)
      .eq("story_id", storyId)
      .order("created_at", { ascending: false })
      .overrideTypes<ConflictWire[], { merge: false }>();
    const childError =
      audioError ??
      audioPartError ??
      transcriptError ??
      versionError ??
      conflictError;
    if (childError) {
      fail(
        isAuthenticationError(childError) ? "AUTH_REQUIRED" : "STORY_OPEN_FAILED",
      );
    }

    const audioSegments = (audioRows ?? []).map(parseAudio);
    const audioParts = (audioPartRows ?? []).map(parseAudioPart);
    const originalTranscripts = (transcriptRows ?? []).map(parseTranscript);
    const versions = (versionRows ?? []).map(parseVersion);
    const editConflicts = (conflictRows ?? []).map(parseConflict);
    if (
      audioSegments.some(
        (segment) =>
          segment.owner_id !== ownerId || segment.story_id !== storyId,
      ) ||
      audioParts.some(
        (part) => part.owner_id !== ownerId || part.story_id !== storyId,
      ) ||
      originalTranscripts.some(
        (transcript) =>
          transcript.owner_id !== ownerId || transcript.story_id !== storyId,
      ) ||
      versions.some(
        (version) =>
          version.owner_id !== ownerId || version.story_id !== storyId,
      ) ||
      editConflicts.some(
        (conflict) =>
          conflict.owner_id !== ownerId || conflict.story_id !== storyId,
      )
    ) {
      fail("INVALID_CLOUD_RESPONSE");
    }

    return {
      story,
      audio_segments: audioSegments,
      audio_parts: audioParts,
      original_transcripts: originalTranscripts,
      versions,
      edit_conflicts: editConflicts,
    };
  }
}

export function createCloudPersistence(
  options: CloudPersistenceOptions = {},
): CloudPersistence {
  let client: SupabaseClient;
  try {
    client = options.client ?? requireSupabaseClient();
  } catch {
    fail("CLOUD_NOT_CONFIGURED");
  }
  return new SupabaseCloudPersistence(client, options.now ?? (() => new Date()));
}
