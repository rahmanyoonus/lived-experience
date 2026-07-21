export class PersistenceInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceInvariantError";
  }
}

export class InvalidPersistenceInputError extends PersistenceInvariantError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPersistenceInputError";
  }
}

export class PersistenceRecordNotFoundError extends PersistenceInvariantError {
  constructor(recordType: string) {
    super(`${recordType} was not found in local storage.`);
    this.name = "PersistenceRecordNotFoundError";
  }
}

export class StaleStoryRevisionError extends PersistenceInvariantError {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super("The local story changed before this save could be acknowledged.");
    this.name = "StaleStoryRevisionError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class ImmutableRecordError extends PersistenceInvariantError {
  constructor(recordType: string) {
    super(`${recordType} is immutable once it has been stored.`);
    this.name = "ImmutableRecordError";
  }
}

export class AudioChunkSequenceError extends PersistenceInvariantError {
  readonly expectedSequenceNumber: number;
  readonly actualSequenceNumber: number;

  constructor(expectedSequenceNumber: number, actualSequenceNumber: number) {
    super("Audio chunks must be stored in MediaRecorder emission order.");
    this.name = "AudioChunkSequenceError";
    this.expectedSequenceNumber = expectedSequenceNumber;
    this.actualSequenceNumber = actualSequenceNumber;
  }
}

export class MigrationConflictError extends PersistenceInvariantError {
  constructor() {
    super("The migration receipt conflicts with the completed migration.");
    this.name = "MigrationConflictError";
  }
}
