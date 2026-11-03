import type { BlobObject, BlobStore, Media, MediaQuery, MediaStore, MemoryStore } from './contracts.ts';
import { MemoryError } from './errors.ts';
import { digest, identifier, instant, invalid, toHex, version } from './validate.ts';

export interface MediaUpload {
  original: Uint8Array<ArrayBuffer>;
  display?: Uint8Array<ArrayBuffer>;
  thumb?: Uint8Array<ArrayBuffer>;
  sha256: string;
  takenAt?: string | null;
  width?: number | null;
  height?: number | null;
  caption?: string | null;
  memoryId?: string | null;
}
/** Both fields are required on every edit; null clears a field. */
export interface MediaEdit {
  memoryId: string | null;
  caption: string | null;
}
export type MediaVariant = 'original' | 'display' | 'thumb';

const MiB = 1024 * 1024;
const variants: MediaVariant[] = ['original', 'display', 'thumb'];
const originalTypes: Media['contentType'][] = ['image/jpeg', 'image/heic', 'image/png', 'image/webp'];
const derivedTypes: Media['contentType'][] = ['image/jpeg', 'image/webp'];
const heifBrands = new Set(['heic', 'heix', 'mif1', 'msf1', 'hevc']);

function dimension(value: unknown): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 100000) invalid('Dimensions must be integers from 1 to 100000');
  return value as number;
}
function caption(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 2000) invalid('Caption must be at most 2000 characters');
  return value as string;
}
/** Type comes from magic bytes only; client-supplied MIME types are never trusted. */
function sniff(bytes: Uint8Array): Media['contentType'] | null {
  const at = (offset: number, text: string) => [...text].every((char, i) => bytes[offset + i] === char.charCodeAt(0));
  if (at(0, '\xff\xd8\xff')) return 'image/jpeg';
  if (at(0, '\x89PNG\r\n\x1a\n')) return 'image/png';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (at(4, 'ftyp') && heifBrands.has(String.fromCharCode(...bytes.subarray(8, 12)))) return 'image/heic';
  return null;
}
function photo(value: unknown, max: number, label: string, types: Media['contentType'][]): Media['contentType'] {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > max) invalid(`${label} must be 1 byte to ${max / MiB} MiB`);
  const type = sniff(value as Uint8Array);
  if (!type || !types.includes(type)) invalid(`${label} has an unsupported format`);
  return type as Media['contentType'];
}

export function createMediaService(deps: { media: MediaStore; blobs: BlobStore; memories: MemoryStore; owner: string; newId: () => string; now: () => string }) {
  if (!deps.owner.trim()) throw new Error('Trusted owner is required');
  const { media, blobs, memories, owner } = deps;
  const keyOf = (id: string, variant: MediaVariant) => `${owner}/${id}/${variant}`;
  const purge = async (keys: string[]) => { if (keys.length) await blobs.delete(keys); };
  async function linkable(value: unknown): Promise<string | null> {
    if (value == null) return null;
    const memoryId = identifier(value);
    if (!await memories.get(owner, memoryId)) throw new MemoryError('NOT_FOUND', 'Memory not found');
    return memoryId;
  }
  // One re-read and one retry after a lost compare-and-set. A photo that vanished or moved to another memory is left alone.
  async function unlink(item: Media, memoryId: string): Promise<boolean> {
    let current: Media | null = item;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (current?.memoryId !== memoryId) return false;
      if (await media.save(owner, { ...current, memoryId: null, version: current.version + 1 }, current.version)) return true;
      current = await media.get(owner, item.id);
    }
    return false;
  }

  return {
    async upload(input: MediaUpload): Promise<{ media: Media; duplicate: boolean }> {
      const contentType = photo(input.original, 25 * MiB, 'Original photo', originalTypes);
      const sha256 = digest(input.sha256);
      if (toHex(await crypto.subtle.digest('SHA-256', input.original)) !== sha256) invalid('SHA-256 does not match the photo');
      const parts: { variant: MediaVariant; body: Uint8Array; contentType: string }[] = [{ variant: 'original', body: input.original, contentType }];
      if (input.display != null) parts.push({ variant: 'display', body: input.display, contentType: photo(input.display, 5 * MiB, 'Display image', derivedTypes) });
      if (input.thumb != null) parts.push({ variant: 'thumb', body: input.thumb, contentType: photo(input.thumb, MiB, 'Thumbnail', derivedTypes) });
      const clean = {
        memoryId: await linkable(input.memoryId),
        takenAt: input.takenAt == null ? null : instant(input.takenAt),
        width: dimension(input.width), height: dimension(input.height), caption: caption(input.caption),
      };
      const [existing] = await media.list(owner, { sha256, limit: 1 });
      if (existing) return { media: existing, duplicate: true };
      const id = identifier(deps.newId());
      // Refuse before writing: a reused ID must never overwrite another photo's blobs.
      if (await media.get(owner, id)) throw new MemoryError('CONFLICT', 'Photo ID already exists');
      const record: Media = { ...clean, id, contentType, bytes: input.original.byteLength, sha256, createdAt: instant(deps.now()), version: 1 };
      const written: string[] = [];
      try {
        for (const part of parts) {
          const key = keyOf(id, part.variant);
          written.push(key);
          await blobs.put(key, part.body, part.contentType);
        }
        if (await media.save(owner, record, null)) return { media: record, duplicate: false };
      } catch (error) {
        await purge(written);
        throw error;
      }
      // Lost the race for this hash (or ID): drop our blobs and report the winner.
      await purge(written);
      const [winner] = await media.list(owner, { sha256, limit: 1 });
      if (winner) return { media: winner, duplicate: true };
      throw new MemoryError('CONFLICT', 'Photo changed during upload; retry');
    },
    async get(id: string): Promise<Media | null> { return media.get(owner, identifier(id)); },
    async list(query: MediaQuery = {}): Promise<Media[]> {
      const limit = query.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid('Limit must be 1–200');
      const clean: MediaQuery = { limit };
      if (query.memoryId !== undefined) clean.memoryId = query.memoryId === null ? null : identifier(query.memoryId);
      if (query.sha256 !== undefined) clean.sha256 = digest(query.sha256);
      if (query.afterId !== undefined) clean.afterId = identifier(query.afterId);
      return media.list(owner, clean);
    },
    async update(id: string, expectedVersion: number, value: MediaEdit): Promise<Media> {
      identifier(id); version(expectedVersion);
      if (expectedVersion === Number.MAX_SAFE_INTEGER) invalid('Photo version limit reached');
      if (!value || value.memoryId === undefined || value.caption === undefined) invalid('memoryId and caption are both required; send null to clear');
      const clean = { memoryId: await linkable(value.memoryId), caption: caption(value.caption) };
      const previous = await media.get(owner, id);
      if (!previous) throw new MemoryError('NOT_FOUND', 'Photo not found');
      const next: Media = { ...previous, ...clean, version: expectedVersion + 1 };
      if (!await media.save(owner, next, expectedVersion)) throw new MemoryError('CONFLICT', 'Photo has changed; read the latest version');
      return next;
    },
    async remove(id: string, expectedVersion: number): Promise<void> {
      identifier(id); version(expectedVersion);
      if (!await media.delete(owner, id, expectedVersion)) throw new MemoryError('CONFLICT', 'Photo missing or changed');
      await blobs.delete(variants.map(variant => keyOf(id, variant)));
    },
    async read(id: string, variant: MediaVariant): Promise<BlobObject | null> {
      identifier(id);
      if (!variants.includes(variant)) invalid('Unknown photo variant');
      if (!await media.get(owner, id)) return null;
      return blobs.get(keyOf(id, variant));
    },
    async unlinkMemory(memoryId: string): Promise<number> {
      identifier(memoryId);
      let unlinked = 0;
      let afterId: string | undefined;
      for (;;) {
        const page = await media.list(owner, { memoryId, afterId, limit: 200 });
        if (!page.length) return unlinked;
        for (const item of page) if (await unlink(item, memoryId)) unlinked++;
        afterId = page[page.length - 1].id;
      }
    },
  };
}
