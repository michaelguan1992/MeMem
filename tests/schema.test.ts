import { test } from 'vitest';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { instantSchema, mediaEdit, mediaUpload, mediaVariantSchema, memoryIdSchema, memoryInput, memoryQuery, parse, parseStored, sha256Schema, versionSchema, type MediaId, type MemoryId } from '../src/core/schema.ts';
import { instantOf, mediaIdOf, memoryIdOf, sha256Of } from './brands.ts';

const MiB = 1024 * 1024;
const jpeg = Buffer.from('\xff\xd8\xffjpeg pixels', 'latin1');
const rejected = (action: () => unknown, message: string) => assert.throws(action, { code: 'INVALID_INPUT', message });

test('a MediaId is a different type from a MemoryId, checked at compile time', () => {
  const photo: MediaId = mediaIdOf('photo-1');
  // @ts-expect-error a MediaId is not a MemoryId, even though both are strings at runtime
  const memory: MemoryId = photo;
  assert.equal(memory, 'photo-1');
});

test('each rule rejects with the message it has always used', () => {
  rejected(() => parse(memoryIdSchema, 'bad id!'), 'Invalid record identifier');
  rejected(() => parse(memoryIdSchema, 7), 'Invalid record identifier');
  rejected(() => parse(instantSchema, '2026-10-09'), 'Time must be an ISO timestamp with timezone');
  rejected(() => parse(versionSchema, 0), 'Expected a positive record version');
  rejected(() => parse(versionSchema, 2 ** 53), 'Expected a positive record version');
  rejected(() => parse(sha256Schema, 'ABC'), 'SHA-256 must be 64 lowercase hex characters');
  rejected(() => parse(memoryInput, { kind: 'diary', text: 'x' }), 'Unknown memory kind');
  rejected(() => parse(memoryInput, { kind: 'fact', text: '   ' }), 'Text must contain 1–20000 characters');
  rejected(() => parse(memoryInput, { kind: 'fact', text: 'x'.repeat(20_001) }), 'Text must contain 1–20000 characters');
  rejected(() => parse(memoryInput, { kind: 'fact', text: 'x', relatedIds: Array.from({ length: 101 }, (_, i) => `r${i}`) }), 'At most 100 related IDs are allowed');
  rejected(() => parse(memoryQuery, { text: 'x'.repeat(501) }), 'Search text is too long');
  rejected(() => parse(memoryQuery, { limit: 201 }), 'Limit must be 1–200');
  rejected(() => parse(memoryQuery, { limit: 0 }), 'Limit must be 1–200');
  rejected(() => parse(mediaVariantSchema, 'raw'), 'Unknown photo variant');
  rejected(() => parse(mediaEdit, null), 'memoryId and caption are both required; send null to clear');
  rejected(() => parse(mediaEdit, { memoryId: null }), 'memoryId and caption are both required; send null to clear');
  rejected(() => parse(mediaUpload, { original: new Uint8Array(0), sha256: sha256Of('a'.repeat(64)) }), 'Original photo must be 1 byte to 25 MiB');
  rejected(() => parse(mediaUpload, { original: Buffer.from('GIF89a', 'latin1'), sha256: sha256Of('a'.repeat(64)) }), 'Original photo has an unsupported format');
  rejected(() => parse(mediaUpload, { original: jpeg, sha256: sha256Of('a'.repeat(64)), display: Buffer.concat([jpeg, Buffer.alloc(5 * MiB)]) }), 'Display image must be 1 byte to 5 MiB');
  rejected(() => parse(mediaUpload, { original: jpeg, sha256: sha256Of('a'.repeat(64)), thumb: Buffer.from('\x89PNG\r\n\x1a\n', 'latin1') }), 'Thumbnail has an unsupported format');
  rejected(() => parse(mediaUpload, { original: jpeg, sha256: sha256Of('a'.repeat(64)), width: 0 }), 'Dimensions must be integers from 1 to 100000');
  rejected(() => parse(mediaUpload, { original: jpeg, sha256: sha256Of('a'.repeat(64)), caption: 'c'.repeat(2001) }), 'Caption must be at most 2000 characters');
});

test('timestamps are stored in UTC, and related IDs are kept once in their first order', () => {
  assert.equal(parse(instantSchema, '2026-10-08T20:00:00-07:00'), '2026-10-09T03:00:00.000Z');
  assert.equal(instantOf('2026-10-09T03:00:00Z'), '2026-10-09T03:00:00.000Z');
  const first = memoryIdOf('a'), second = memoryIdOf('b');
  const content = parse(memoryInput, { kind: 'fact', text: 'x', relatedIds: [second, second, first] });
  assert.deepEqual(content, { kind: 'fact', text: 'x', occurredAt: null, relatedIds: [second, first] });
});

test('a field that is missing from an edit names both required fields', () => {
  rejected(() => parse(mediaEdit, { caption: null }), 'memoryId and caption are both required; send null to clear');
});

test('an ISO base-media file is a photo only when its brand is a HEIF brand', () => {
  const otherBrand = Buffer.from('\x00\x00\x00\x18ftypisom\x00\x00\x00\x00', 'latin1');
  const noFtypBox = Buffer.from('\x00\x00\x00\x18xxxxheicheic pixels', 'latin1');
  rejected(() => parse(mediaUpload, { original: otherBrand, sha256: sha256Of('a'.repeat(64)) }), 'Original photo has an unsupported format');
  rejected(() => parse(mediaUpload, { original: noFtypBox, sha256: sha256Of('a'.repeat(64)) }), 'Original photo has an unsupported format');
});

test('a one-byte photo is within the size rule, so it fails on its format', () => {
  rejected(() => parse(mediaUpload, { original: new Uint8Array(1), sha256: sha256Of('a'.repeat(64)) }), 'Original photo has an unsupported format');
});

test('a stored value that breaks a rule is reported with that rule message', () => {
  assert.throws(
    () => parseStored(z.object({ text: z.string({ error: 'Text must be a string' }) }), { text: 1 }, 'memory row'),
    { message: 'Corrupt memory row in storage: Text must be a string' },
  );
});
