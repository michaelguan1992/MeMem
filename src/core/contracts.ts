/** No provider SDK, HTTP, SQL, environment variables, or AI model types here. Only type imports from the schema. */
import type { Instant, MediaId, MemoryId, MemoryKind, PhotoContentType, Sha256, Version } from './schema.ts';

export interface Memory {
  id: MemoryId;
  kind: MemoryKind;
  text: string;
  /** The first text this record was saved with; kept as history and never returned to clients. */
  originalText: string;
  /** Actual event time, supplied explicitly; null means unknown. */
  occurredAt: Instant | null;
  /** Related record IDs, not inferred names or assumed relationships. */
  relatedIds: MemoryId[];
  createdAt: Instant;
  updatedAt: Instant;
  version: Version;
}
export interface MemoryQuery {
  /** Literal case-insensitive substring, NOT semantic search. */
  text?: string;
  relatedTo?: MemoryId;
  /** Inclusive start / exclusive end against occurredAt; unknown times excluded. */
  from?: Instant;
  before?: Instant;
  /** Keyset pagination in ascending record ID order, NOT chronological order. */
  afterId?: MemoryId;
  limit?: number;
}
/** Adapter contract. All operations MUST enforce the trusted owner scope.
 * save/delete are atomic compare-and-set operations. Never implement as read then write.
 * false indicates version conflict / missing record, not a provider outage.
 * Provider failures reject. Results must be detached values, not mutable store references.
 */
export interface MemoryStore {
  get(owner: string, id: MemoryId): Promise<Memory | null>;
  list(owner: string, query: MemoryQuery): Promise<Memory[]>;
  save(owner: string, memory: Memory, expectedVersion: Version | null): Promise<boolean>;
  delete(owner: string, id: MemoryId, expectedVersion: Version): Promise<boolean>;
}

/** Platform-neutral metadata for one privately stored photo. */
export interface Media {
  id: MediaId;
  memoryId: MemoryId | null;
  contentType: PhotoContentType;
  bytes: number;
  sha256: Sha256;
  takenAt: Instant | null;
  width: number | null;
  height: number | null;
  caption: string | null;
  createdAt: Instant;
  version: Version;
}
export interface MediaQuery {
  memoryId?: MemoryId | null;
  sha256?: Sha256;
  afterId?: MediaId;
  limit?: number;
}
/**
 * Owner-scoped metadata adapter. save/delete are atomic compare-and-set operations;
 * false means missing, conflicting version, or duplicate identifier/hash. Returned
 * metadata must be detached values, never mutable adapter references.
 */
export interface MediaStore {
  get(owner: string, id: MediaId): Promise<Media | null>;
  list(owner: string, query?: MediaQuery): Promise<Media[]>;
  save(owner: string, media: Media, expectedVersion: Version | null): Promise<boolean>;
  delete(owner: string, id: MediaId, expectedVersion: Version): Promise<boolean>;
}
export interface BlobObject {
  body: ReadableStream<Uint8Array> | Uint8Array;
  contentType: string;
}
/** Private object storage boundary; core code does not depend on R2 types. */
export interface BlobStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<BlobObject | null>;
  delete(keys: string[]): Promise<void>;
}
export interface CoreDependencies {
  store: MemoryStore;
  /** Set by the authenticated deployment layer, never by an AI tool argument. */
  owner: string;
  newId: () => string;
  now: () => string;
}
