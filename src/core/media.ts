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

export function createMediaService(deps: { media: MediaStore; blobs: BlobStore; memories: MemoryStore; owner: string; newId: () => string; now: () => string }) {
  if (!deps.owner.trim()) throw new Error('Trusted owner is required');
  const { media, blobs, memories, owner } = deps;
  // Blob keys are content-addressed: one photo (owner and SHA-256) always maps to the same three keys.
  const keyOf = (sha256: Sha256, variant: MediaVariant) => `${owner}/${sha256}/${variant}`;
  async function linkable(memoryId: MemoryId | null | undefined): Promise<MemoryId | null> {
    if (memoryId == null) return null;
    if (!await memories.get(owner, memoryId)) throw new MemoryError('NOT_FOUND', 'Memory not found');
    return memoryId;
  }
  // One re-read and one retry after a lost compare-and-set. A photo that vanished or moved to another memory is left alone.
  async function unlink(item: Media, memoryId: MemoryId): Promise<boolean> {
    let current: Media | null = item;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (current?.memoryId !== memoryId) return false;
      if (await media.save(owner, { ...current, memoryId: null, version: parse(versionSchema, current.version + 1) }, current.version)) return true;
      current = await media.get(owner, item.id);
    }
    return false;
  }

  return {
    async upload(input: MediaUpload): Promise<{ media: Media; duplicate: boolean }> {
      const upload = parse(mediaUpload, input);
      if (await sha256Hex(upload.original.bytes) !== upload.sha256) invalid('SHA-256 does not match the photo');
      const parts: { variant: MediaVariant; body: Uint8Array<ArrayBuffer>; contentType: PhotoContentType }[] = [
        { variant: 'original', body: upload.original.bytes, contentType: upload.original.contentType },
      ];
      if (upload.display) parts.push({ variant: 'display', body: upload.display.bytes, contentType: upload.display.contentType });
      if (upload.thumb) parts.push({ variant: 'thumb', body: upload.thumb.bytes, contentType: upload.thumb.contentType });
      const clean = {
        memoryId: await linkable(upload.memoryId),
        takenAt: upload.takenAt ?? null, width: upload.width ?? null, height: upload.height ?? null, caption: upload.caption ?? null,
      };
      // Every attempt writes the provided parts under the photo's own keys. On a duplicate this repairs blobs lost out of
      // band; a failed or lost attempt leaves only these keys, which the next attempt overwrites. Nothing is purged here.
      for (const part of parts) await blobs.put(keyOf(upload.sha256, part.variant), part.body, part.contentType);
      const [existing] = await media.list(owner, { sha256: upload.sha256, limit: 1 });
      if (existing) return { media: existing, duplicate: true };
      const id = parse(mediaIdSchema, deps.newId());
      const record: Media = {
        ...clean, id, contentType: upload.original.contentType, bytes: upload.original.bytes.byteLength, sha256: upload.sha256,
        createdAt: parse(instantSchema, deps.now()), version: FIRST_VERSION,
      };
      if (await media.save(owner, record, null)) return { media: record, duplicate: false };
      // Lost the race for this hash, or the ID is taken. The winner's blobs use the same keys, so nothing is deleted.
      const [winner] = await media.list(owner, { sha256: upload.sha256, limit: 1 });
      if (winner) return { media: winner, duplicate: true };
      if (await media.get(owner, id)) throw new MemoryError('CONFLICT', 'Photo ID already exists');
      throw new MemoryError('CONFLICT', 'Photo changed during upload; retry');
    },
    async get(id: string): Promise<Media | null> { return media.get(owner, parse(mediaIdSchema, id)); },
    async list(query: MediaQueryInput = {}): Promise<Media[]> {
      const clean: MediaQuery = parse(mediaQuery, query);
      return media.list(owner, clean);
    },
    async update(id: string, expectedVersion: number, value: MediaEdit): Promise<Media> {
      const mediaKey = parse(mediaIdSchema, id);
      const expected = parse(versionSchema, expectedVersion);
      if (expected === Number.MAX_SAFE_INTEGER) invalid('Photo version limit reached');
      const edit = parse(mediaEdit, value);
      const clean = { memoryId: await linkable(edit.memoryId), caption: edit.caption };
      const previous = await media.get(owner, mediaKey);
      if (!previous) throw new MemoryError('NOT_FOUND', 'Photo not found');
      const next: Media = { ...previous, ...clean, version: parse(versionSchema, expected + 1) };
      if (!await media.save(owner, next, expected)) throw new MemoryError('CONFLICT', 'Photo has changed; read the latest version');
      return next;
    },
    async remove(id: string, expectedVersion: number): Promise<void> {
      const mediaKey = parse(mediaIdSchema, id);
      const expected = parse(versionSchema, expectedVersion);
      const item = await media.get(owner, mediaKey);
      // Already gone: the state this call asks for already holds, so a repeat succeeds.
      if (!item) return;
      if (item.version !== expected) throw new MemoryError('CONFLICT', 'Photo missing or changed');
      // Blobs go first. A crash here leaves the row, and a retry finishes the job; a reported success never leaves bytes behind.
      await blobs.delete(MEDIA_VARIANTS.map((variant) => keyOf(item.sha256, variant)));
      if (await media.delete(owner, mediaKey, expected)) return;
      // The compare-and-set lost: a row still there has changed (conflict); a row that is gone was removed meanwhile (success).
      if (await media.get(owner, mediaKey)) throw new MemoryError('CONFLICT', 'Photo missing or changed');
    },
    async read(id: string, variant: MediaVariant): Promise<BlobObject | null> {
      const mediaKey = parse(mediaIdSchema, id);
      const checked = parse(mediaVariantSchema, variant);
      const item = await media.get(owner, mediaKey);
      return item ? blobs.get(keyOf(item.sha256, checked)) : null;
    },
    async unlinkMemory(memoryId: string): Promise<number> {
      const linked = parse(memoryIdSchema, memoryId);
      let unlinked = 0;
      let afterId: MediaId | undefined;
      for (;;) {
        const page = await media.list(owner, { memoryId: linked, afterId, limit: MAX_PAGE_LIMIT });
        if (!page.length) return unlinked;
        for (const item of page) if (await unlink(item, linked)) unlinked++;
        afterId = page[page.length - 1].id;
      }
    },
  };
}
