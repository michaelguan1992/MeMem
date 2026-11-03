import type { z } from 'zod';
import type { BlobObject, BlobStore, Media, MediaQuery, MediaStore, MemoryStore } from './contracts.ts';
import { MemoryError, invalid } from './errors.ts';
import {
  FIRST_VERSION, instantSchema, MAX_PAGE_LIMIT, mediaEdit, mediaIdSchema, mediaQuery, mediaUpload, mediaVariantSchema, memoryIdSchema,
  MEDIA_VARIANTS, parse, versionSchema, type MediaEdit, type MediaId, type MediaQueryInput, type MediaUpload, type MediaVariant,
  type MemoryId, type PhotoContentType, type Sha256,
} from './schema.ts';

/** Lowercase hex SHA-256 of the bytes, the form the schema accepts for a photo's digest. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** What every media operation reads. The factory builds it once; `newId` and `now` are read at each call. */
interface MediaContext {
  media: MediaStore;
  blobs: BlobStore;
  memories: MemoryStore;
  owner: string;
  newId: () => string;
  now: () => string;
}
type ParsedUpload = z.output<typeof mediaUpload>;
type PhotoFields = Pick<Media, 'memoryId' | 'takenAt' | 'width' | 'height' | 'caption'>;
interface UploadPart { variant: MediaVariant; body: Uint8Array<ArrayBuffer>; contentType: PhotoContentType }
interface UploadResult { media: Media; duplicate: boolean }

// Blob keys are content-addressed: one photo (owner and SHA-256) always maps to the same three keys.
const keyOf = (owner: string, sha256: Sha256, variant: MediaVariant) => `${owner}/${sha256}/${variant}`;

async function linkable(ctx: MediaContext, memoryId: MemoryId | null | undefined): Promise<MemoryId | null> {
  if (memoryId == null) return null;
  if (!await ctx.memories.get(ctx.owner, memoryId)) throw new MemoryError('NOT_FOUND', 'Memory not found');
  return memoryId;
}

// One re-read and one retry after a lost compare-and-set. A photo that vanished or moved to another memory is left alone.
async function unlink(ctx: MediaContext, item: Media, memoryId: MemoryId): Promise<boolean> {
  let current: Media | null = item;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (current?.memoryId !== memoryId) return false;
    if (await ctx.media.save(ctx.owner, { ...current, memoryId: null, version: parse(versionSchema, current.version + 1) }, current.version)) return true;
    current = await ctx.media.get(ctx.owner, item.id);
  }
  return false;
}

/** The parts in write order: the original, then whichever derivatives were sent. */
function uploadParts(upload: ParsedUpload): UploadPart[] {
  const parts: UploadPart[] = [{ variant: 'original', body: upload.original.bytes, contentType: upload.original.contentType }];
  if (upload.display) parts.push({ variant: 'display', body: upload.display.bytes, contentType: upload.display.contentType });
  if (upload.thumb) parts.push({ variant: 'thumb', body: upload.thumb.bytes, contentType: upload.thumb.contentType });
  return parts;
}

/** The optional metadata of a new photo. A memory link is checked here, before any bytes are written. */
async function photoFields(ctx: MediaContext, upload: ParsedUpload): Promise<PhotoFields> {
  return {
    memoryId: await linkable(ctx, upload.memoryId),
    takenAt: upload.takenAt ?? null, width: upload.width ?? null, height: upload.height ?? null, caption: upload.caption ?? null,
  };
}

async function firstWithHash(ctx: MediaContext, sha256: Sha256): Promise<Media | undefined> {
  const [found] = await ctx.media.list(ctx.owner, { sha256, limit: 1 });
  return found;
}

async function uploadMedia(ctx: MediaContext, input: MediaUpload): Promise<UploadResult> {
  const upload = parse(mediaUpload, input);
  if (await sha256Hex(upload.original.bytes) !== upload.sha256) invalid('SHA-256 does not match the photo');
  const fields = await photoFields(ctx, upload);
  // Every attempt writes the provided parts under the photo's own keys. On a duplicate this repairs blobs lost out of
  // band; a failed or lost attempt leaves only these keys, which the next attempt overwrites. Nothing is purged here.
  for (const part of uploadParts(upload)) await ctx.blobs.put(keyOf(ctx.owner, upload.sha256, part.variant), part.body, part.contentType);
  const existing = await firstWithHash(ctx, upload.sha256);
  if (existing) return { media: existing, duplicate: true };
  return createPhoto(ctx, upload, fields);
}

/** Creates the record for a hash that is not stored yet, or reports how a lost race ended. */
async function createPhoto(ctx: MediaContext, upload: ParsedUpload, fields: PhotoFields): Promise<UploadResult> {
  const id = parse(mediaIdSchema, ctx.newId());
  const record: Media = {
    ...fields, id, contentType: upload.original.contentType, bytes: upload.original.bytes.byteLength, sha256: upload.sha256,
    createdAt: parse(instantSchema, ctx.now()), version: FIRST_VERSION,
  };
  if (await ctx.media.save(ctx.owner, record, null)) return { media: record, duplicate: false };
  // Lost the race for this hash, or the ID is taken. The winner's blobs use the same keys, so nothing is deleted.
  const winner = await firstWithHash(ctx, upload.sha256);
  if (winner) return { media: winner, duplicate: true };
  if (await ctx.media.get(ctx.owner, id)) throw new MemoryError('CONFLICT', 'Photo ID already exists');
  throw new MemoryError('CONFLICT', 'Photo changed during upload; retry');
}

async function getMedia(ctx: MediaContext, id: string): Promise<Media | null> {
  return ctx.media.get(ctx.owner, parse(mediaIdSchema, id));
}

async function listMedia(ctx: MediaContext, query: MediaQueryInput): Promise<Media[]> {
  const clean: MediaQuery = parse(mediaQuery, query);
  return ctx.media.list(ctx.owner, clean);
}

async function editMedia(ctx: MediaContext, id: string, expectedVersion: number, value: MediaEdit): Promise<Media> {
  const mediaKey = parse(mediaIdSchema, id);
  const expected = parse(versionSchema, expectedVersion);
  if (expected === Number.MAX_SAFE_INTEGER) invalid('Photo version limit reached');
  const edit = parse(mediaEdit, value);
  const clean = { memoryId: await linkable(ctx, edit.memoryId), caption: edit.caption };
  const previous = await ctx.media.get(ctx.owner, mediaKey);
  if (!previous) throw new MemoryError('NOT_FOUND', 'Photo not found');
  const next: Media = { ...previous, ...clean, version: parse(versionSchema, expected + 1) };
  if (!await ctx.media.save(ctx.owner, next, expected)) throw new MemoryError('CONFLICT', 'Photo has changed; read the latest version');
  return next;
}

async function removeMedia(ctx: MediaContext, id: string, expectedVersion: number): Promise<void> {
  const mediaKey = parse(mediaIdSchema, id);
  const expected = parse(versionSchema, expectedVersion);
  const item = await ctx.media.get(ctx.owner, mediaKey);
  // Already gone: the state this call asks for already holds, so a repeat succeeds.
  if (!item) return;
  if (item.version !== expected) throw new MemoryError('CONFLICT', 'Photo missing or changed');
  // Blobs go first. A crash here leaves the row, and a retry finishes the job; a reported success never leaves bytes behind.
  await ctx.blobs.delete(MEDIA_VARIANTS.map((variant) => keyOf(ctx.owner, item.sha256, variant)));
  if (await ctx.media.delete(ctx.owner, mediaKey, expected)) return;
  // The compare-and-set lost: a row still there has changed (conflict); a row that is gone was removed meanwhile (success).
  if (await ctx.media.get(ctx.owner, mediaKey)) throw new MemoryError('CONFLICT', 'Photo missing or changed');
}

async function readMedia(ctx: MediaContext, id: string, variant: MediaVariant): Promise<BlobObject | null> {
  const mediaKey = parse(mediaIdSchema, id);
  const checked = parse(mediaVariantSchema, variant);
  const item = await ctx.media.get(ctx.owner, mediaKey);
  return item ? ctx.blobs.get(keyOf(ctx.owner, item.sha256, checked)) : null;
}

async function unlinkMemoryMedia(ctx: MediaContext, memoryId: string): Promise<number> {
  const linked = parse(memoryIdSchema, memoryId);
  let unlinked = 0;
  let afterId: MediaId | undefined;
  for (;;) {
    const page = await ctx.media.list(ctx.owner, { memoryId: linked, afterId, limit: MAX_PAGE_LIMIT });
    if (!page.length) return unlinked;
    for (const item of page) if (await unlink(ctx, item, linked)) unlinked++;
    afterId = page[page.length - 1].id;
  }
}

export function createMediaService(deps: { media: MediaStore; blobs: BlobStore; memories: MemoryStore; owner: string; newId: () => string; now: () => string }) {
  if (!deps.owner.trim()) throw new Error('Trusted owner is required');
  const ctx: MediaContext = {
    media: deps.media, blobs: deps.blobs, memories: deps.memories, owner: deps.owner,
    newId: () => deps.newId(), now: () => deps.now(),
  };
  return {
    async upload(input: MediaUpload): Promise<UploadResult> { return uploadMedia(ctx, input); },
    async get(id: string): Promise<Media | null> { return getMedia(ctx, id); },
    async list(query: MediaQueryInput = {}): Promise<Media[]> { return listMedia(ctx, query); },
    async update(id: string, expectedVersion: number, value: MediaEdit): Promise<Media> { return editMedia(ctx, id, expectedVersion, value); },
    async remove(id: string, expectedVersion: number): Promise<void> { return removeMedia(ctx, id, expectedVersion); },
    async read(id: string, variant: MediaVariant): Promise<BlobObject | null> { return readMedia(ctx, id, variant); },
    async unlinkMemory(memoryId: string): Promise<number> { return unlinkMemoryMedia(ctx, memoryId); },
  };
}
