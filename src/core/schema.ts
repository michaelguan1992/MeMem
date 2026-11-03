import { z } from 'zod';
import { invalid } from './errors.ts';

// The single source of the memory rules. Every adapter (MCP tools, the web API, storage rows) takes its
// schemas from this file, and no other file restates a limit, pattern or message. The MCP tool JSON Schemas
// are generated from these schemas with io: 'input', so brands and transforms never reach a client.

// Vocabulary. Each list is written once; the TypeScript types are derived from these tuples.
export const MEMORY_KINDS = ['event', 'person', 'place', 'fact'] as const;
export const MEDIA_VARIANTS = ['original', 'display', 'thumb'] as const;
export const PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/heic', 'image/png', 'image/webp'] as const;
export const DERIVED_CONTENT_TYPES = ['image/jpeg', 'image/webp'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MediaVariant = (typeof MEDIA_VARIANTS)[number];
export type PhotoContentType = (typeof PHOTO_CONTENT_TYPES)[number];

// Limits.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MiB = 1024 * 1024;
const TEXT_MAX_LENGTH = 20_000;
const SEARCH_TEXT_MAX_LENGTH = 500;
const RELATED_IDS_MAX = 100;
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
const CAPTION_MAX_LENGTH = 2000;
const DIMENSION_MAX = 100_000;
export const ORIGINAL_MAX_BYTES = 25 * MiB;
const DISPLAY_MAX_BYTES = 5 * MiB;
const THUMB_MAX_BYTES = MiB;

// Messages. Each is the text a rejected input has always produced.
const ID_ERROR = 'Invalid record identifier';
const SHA256_ERROR = 'SHA-256 must be 64 lowercase hex characters';
const INSTANT_ERROR = 'Time must be an ISO timestamp with timezone';
const VERSION_ERROR = 'Expected a positive record version';
const KIND_ERROR = 'Unknown memory kind';
const TEXT_ERROR = `Text must contain 1–${TEXT_MAX_LENGTH} characters`;
const RELATED_ERROR = `At most ${RELATED_IDS_MAX} related IDs are allowed`;
const SEARCH_TEXT_ERROR = 'Search text is too long';
const LIMIT_ERROR = `Limit must be 1–${MAX_PAGE_LIMIT}`;
const CAPTION_ERROR = `Caption must be at most ${CAPTION_MAX_LENGTH} characters`;
const DIMENSION_ERROR = `Dimensions must be integers from 1 to ${DIMENSION_MAX}`;
const EDIT_REQUIRED = 'memoryId and caption are both required; send null to clear';
const VARIANT_ERROR = 'Unknown photo variant';

// Identifiers. A field whose value is absent reports `missing` instead of the format message; only edits need that.
const identifierField = (missing = ID_ERROR) => z.string({ error: (issue) => (issue.input === undefined ? missing : ID_ERROR) })
  .regex(ID_PATTERN, { error: ID_ERROR });
export const memoryIdSchema = identifierField().brand<'MemoryId'>();
export const mediaIdSchema = identifierField().brand<'MediaId'>();
const editMemoryIdSchema = identifierField(EDIT_REQUIRED).brand<'MemoryId'>();

export const sha256Schema = z.string({ error: SHA256_ERROR }).regex(/^[0-9a-f]{64}$/, { error: SHA256_ERROR }).brand<'Sha256'>();

/** An offset timestamp, stored in UTC. The ISO rule is the one the MCP tools have always advertised as date-time. */
export const instantSchema = z.iso.datetime({ offset: true, error: INSTANT_ERROR })
  .refine((value) => Number.isFinite(Date.parse(value)), { error: INSTANT_ERROR })
  .transform((value) => new Date(value).toISOString())
  .brand<'Instant'>();

export const versionSchema = z.number({ error: VERSION_ERROR }).int().positive().safe().brand<'Version'>();

// Memories.
export const memoryKindSchema = z.enum(MEMORY_KINDS, { error: KIND_ERROR });
/** Text is kept as written; it must contain something other than white space. */
export const memoryTextSchema = z.string({ error: TEXT_ERROR }).min(1, { error: TEXT_ERROR }).max(TEXT_MAX_LENGTH, { error: TEXT_ERROR })
  .refine((text) => text.trim() !== '', { error: TEXT_ERROR });
export const relatedIdList = z.array(memoryIdSchema, { error: RELATED_ERROR }).max(RELATED_IDS_MAX, { error: RELATED_ERROR });

/** The fields of a memory as a client sends them. Strictness is added by each adapter, not here. */
export const memoryFields = {
  kind: memoryKindSchema,
  text: memoryTextSchema,
  occurredAt: instantSchema.nullable().optional(),
  relatedIds: relatedIdList.optional(),
};

/** Parses a memory into the content that is stored: null for an unknown time, and related IDs without duplicates. */
export const memoryInput = z.object(memoryFields, { error: KIND_ERROR }).transform(({ kind, text, occurredAt, relatedIds }) => ({
  kind, text, occurredAt: occurredAt ?? null, relatedIds: [...new Set(relatedIds ?? [])],
}));
export type MemoryInput = z.input<typeof memoryInput>;
export type MemoryContent = z.output<typeof memoryInput>;

const searchTextField = z.string({ error: SEARCH_TEXT_ERROR }).max(SEARCH_TEXT_MAX_LENGTH, { error: SEARCH_TEXT_ERROR });
export const pageLimitSchema = z.number({ error: LIMIT_ERROR }).int().min(1).max(MAX_PAGE_LIMIT);

/** Search filters as a client sends them. The page size defaults here, and the time-range rule is checked by the service. */
export const memoryQueryFields = {
  text: searchTextField.optional(),
  relatedTo: memoryIdSchema.optional(),
  from: instantSchema.optional(),
  before: instantSchema.optional(),
  afterId: memoryIdSchema.optional(),
  limit: pageLimitSchema.optional(),
};
export const memoryQuery = z.object(memoryQueryFields).transform((query) => ({ ...query, limit: query.limit ?? DEFAULT_PAGE_LIMIT }));
export type MemoryQueryInput = z.input<typeof memoryQuery>;

// Photos.
export const mediaVariantSchema = z.enum(MEDIA_VARIANTS, { error: VARIANT_ERROR });
export const photoContentTypeSchema = z.enum(PHOTO_CONTENT_TYPES);
export const originalBytesSchema = z.number().int().min(1).max(ORIGINAL_MAX_BYTES);
export const dimensionSchema = z.number({ error: DIMENSION_ERROR }).int().min(1).max(DIMENSION_MAX);
const captionField = (missing = CAPTION_ERROR) => z.string({ error: (issue) => (issue.input === undefined ? missing : CAPTION_ERROR) })
  .max(CAPTION_MAX_LENGTH, { error: CAPTION_ERROR });
export const captionSchema = captionField();

const HEIF_BRANDS = new Set(['heic', 'heix', 'mif1', 'msf1', 'hevc']);
/** The type comes from magic bytes only; client-supplied MIME types are never trusted. */
export function sniffPhotoType(bytes: Uint8Array): PhotoContentType | null {
  const at = (offset: number, text: string) => [...text].every((char, i) => bytes[offset + i] === char.charCodeAt(0));
  if (at(0, '\xff\xd8\xff')) return 'image/jpeg';
  if (at(0, '\x89PNG\r\n\x1a\n')) return 'image/png';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (at(4, 'ftyp') && HEIF_BRANDS.has(String.fromCharCode(...bytes.subarray(8, 12)))) return 'image/heic';
  return null;
}
/** One photo part: its size limit, and the content types its magic bytes may identify as. */
const photoPart = (label: string, maxBytes: number, types: readonly PhotoContentType[]) => z.custom<Uint8Array<ArrayBuffer>>(
  (value) => value instanceof Uint8Array && value.byteLength >= 1 && value.byteLength <= maxBytes,
  { error: `${label} must be 1 byte to ${maxBytes / MiB} MiB` },
).transform((bytes, ctx) => {
  const contentType = sniffPhotoType(bytes);
  if (contentType === null || !types.includes(contentType)) {
    ctx.addIssue({ code: 'custom', message: `${label} has an unsupported format`, input: bytes });
    return z.NEVER;
  }
  return { bytes, contentType };
});
const originalPhoto = photoPart('Original photo', ORIGINAL_MAX_BYTES, PHOTO_CONTENT_TYPES);
const displayPhoto = photoPart('Display image', DISPLAY_MAX_BYTES, DERIVED_CONTENT_TYPES);
const thumbPhoto = photoPart('Thumbnail', THUMB_MAX_BYTES, DERIVED_CONTENT_TYPES);

/** A new photo. Parts are listed in the order their checks have always run. */
export const mediaUploadFields = {
  original: originalPhoto,
  sha256: sha256Schema,
  display: displayPhoto.nullish(),
  thumb: thumbPhoto.nullish(),
  memoryId: memoryIdSchema.nullish(),
  takenAt: instantSchema.nullish(),
  width: dimensionSchema.nullish(),
  height: dimensionSchema.nullish(),
  caption: captionSchema.nullish(),
};
export const mediaUpload = z.object(mediaUploadFields);
export type MediaUpload = z.input<typeof mediaUpload>;

/** A metadata edit. Both fields are required on every edit; null clears a field. */
export const mediaEditFields = {
  memoryId: editMemoryIdSchema.nullable(),
  caption: captionField(EDIT_REQUIRED).nullable(),
};
export const mediaEdit = z.object(mediaEditFields, { error: EDIT_REQUIRED });
export type MediaEdit = z.input<typeof mediaEdit>;

export const mediaQueryFields = {
  memoryId: memoryIdSchema.nullable().optional(),
  sha256: sha256Schema.optional(),
  afterId: mediaIdSchema.optional(),
  limit: pageLimitSchema.optional(),
};
export const mediaQuery = z.object(mediaQueryFields).transform((query) => ({ ...query, limit: query.limit ?? DEFAULT_PAGE_LIMIT }));
export type MediaQueryInput = z.input<typeof mediaQuery>;

// Branded values. A brand exists only after a schema has accepted the value, so a checked ID cannot be
// confused with another kind of ID, and a timestamp or digest has the one normalized form.
export type MemoryId = z.output<typeof memoryIdSchema>;
export type MediaId = z.output<typeof mediaIdSchema>;
export type Sha256 = z.output<typeof sha256Schema>;
export type Instant = z.output<typeof instantSchema>;
export type Version = z.output<typeof versionSchema>;

/** Every record starts at version 1, and each change adds one. */
export const FIRST_VERSION: Version = parse(versionSchema, 1);

/**
 * Parses a value from a public boundary (a caller, a tool, a request). The first failing rule becomes the
 * INVALID_INPUT error; no zod message reaches a client.
 */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  return result.success ? result.data : invalid(result.error.issues[0]?.message ?? 'Invalid input');
}

/**
 * Parses a row or payload read back from storage. Stored data is trusted only after it passes the same rules
 * as new input. A failure means the storage is corrupt, so it is a plain error, never a client error.
 */
export function parseStored<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`Corrupt ${what} in storage: ${result.error.issues[0]?.message ?? 'invalid value'}`);
  return result.data;
}
