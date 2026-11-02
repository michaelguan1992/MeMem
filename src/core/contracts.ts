/** No provider SDK, HTTP, SQL, environment variables, or AI model types here. */
export type MemoryKind = 'event' | 'person' | 'place' | 'fact';
export interface MemoryInput {
  kind: MemoryKind;
  text: string;
  /** Actual event time, supplied explicitly; null means unknown. */
  occurredAt?: string | null;
  /** Related record IDs, not inferred names or assumed relationships. */
  relatedIds?: string[];
}
export interface Memory extends MemoryInput {
  id: string;
  originalText: string;
  occurredAt: string | null;
  relatedIds: string[];
  createdAt: string;
  updatedAt: string;
  version: number;
}
export interface MemoryQuery {
  /** Literal case-insensitive substring, NOT semantic search. */
  text?: string;
  relatedTo?: string;
  /** Inclusive start / exclusive end against occurredAt; unknown times excluded. */
  from?: string;
  before?: string;
  /** Keyset pagination in ascending record ID order, NOT chronological order. */
  afterId?: string;
  limit?: number;
}
/** Adapter contract. All operations MUST enforce the trusted owner scope.
 * save/delete are atomic compare-and-set operations. Never implement as read then write.
 * false indicates version conflict / missing record, not a provider outage.
 * Provider failures reject. Results must be detached values, not mutable store references.
 */
export interface MemoryStore {
  get(owner: string, id: string): Promise<Memory | null>;
  list(owner: string, query: MemoryQuery): Promise<Memory[]>;
  save(owner: string, memory: Memory, expectedVersion: number | null): Promise<boolean>;
  delete(owner: string, id: string, expectedVersion: number): Promise<boolean>;
}

/** Platform-neutral metadata for one privately stored photo. */
export interface Media {
  id: string;
  memoryId: string | null;
  contentType: 'image/jpeg' | 'image/heic' | 'image/png' | 'image/webp';
  bytes: number;
  sha256: string;
  takenAt: string | null;
  width: number | null;
  height: number | null;
  caption: string | null;
  createdAt: string;
  version: number;
}
export interface MediaQuery {
  memoryId?: string | null;
  sha256?: string;
  afterId?: string;
  limit?: number;
}
/**
 * Owner-scoped metadata adapter. save/delete are atomic compare-and-set operations;
 * false means missing, conflicting version, or duplicate identifier/hash. Returned
 * metadata must be detached values, never mutable adapter references.
 */
export interface MediaStore {
  get(owner: string, id: string): Promise<Media | null>;
  list(owner: string, query?: MediaQuery): Promise<Media[]>;
  save(owner: string, media: Media, expectedVersion: number | null): Promise<boolean>;
  delete(owner: string, id: string, expectedVersion: number): Promise<boolean>;
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
