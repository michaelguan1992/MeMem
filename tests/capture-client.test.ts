import { test } from 'vitest';
import assert from 'node:assert/strict';
import { captureScript } from '../src/generated/capture-script.ts';
import { readJpegTakenAt } from '../src/client/exif.ts';

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));
function u16(value: number, little: boolean): number[] {
  return little ? [value & 0xff, (value >> 8) & 0xff] : [(value >> 8) & 0xff, value & 0xff];
}
function u32(value: number, little: boolean): number[] {
  const bytes = [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
  return little ? bytes : bytes.reverse();
}
/** TIFF block: IFD0 points to an Exif sub-IFD that holds DateTimeOriginal and, optionally, OffsetTimeOriginal. */
function tiffBlock(options: { little: boolean; dateTime: string; zone?: string }): number[] {
  const { little } = options;
  const date = [...ascii(options.dateTime), 0];
  const zone = options.zone === undefined ? null : [...ascii(options.zone), 0];
  const entries = zone ? 2 : 1;
  const exifAt = 8 + 2 + 12 + 4;
  const dateAt = exifAt + 2 + entries * 12 + 4;
  const zoneAt = dateAt + date.length;
  return [
    ...ascii(little ? 'II' : 'MM'), ...u16(42, little), ...u32(8, little),
    ...u16(1, little), ...u16(0x8769, little), ...u16(4, little), ...u32(1, little), ...u32(exifAt, little), ...u32(0, little),
    ...u16(entries, little),
    ...u16(0x9003, little), ...u16(2, little), ...u32(date.length, little), ...u32(dateAt, little),
    ...(zone ? [...u16(0x9011, little), ...u16(2, little), ...u32(zone.length, little), ...u32(zoneAt, little)] : []),
    ...u32(0, little),
    ...date,
    ...(zone ?? []),
  ];
}
// A JFIF APP0 segment followed by fill bytes, the layout many cameras and editors write before the EXIF block.
const jfifWithFill = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xff];
function jpeg(tiff: number[], prefix: number[] = []): Uint8Array {
  const app1 = [...ascii('Exif'), 0, 0, ...tiff];
  return Uint8Array.from([
    0xff, 0xd8,
    ...prefix,
    0xff, 0xe1, ...u16(app1.length + 2, false), ...app1,
    0xff, 0xda, 0x00, 0x02,
    0xff, 0xd9,
  ]);
}
const isIsoWithOffset = (text: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(text);

test('little-endian EXIF uses the photo offset, which wins over the fallback', () => {
  const bytes = jpeg(tiffBlock({ little: true, dateTime: '2025:05:01 14:30:00', zone: '+09:00' }));
  assert.equal(readJpegTakenAt(bytes, 480), '2025-05-01T14:30:00+09:00');
  assert.equal(readJpegTakenAt(bytes, -300), '2025-05-01T14:30:00+09:00');
});

test('big-endian EXIF with a negative photo offset', () => {
  const bytes = jpeg(tiffBlock({ little: false, dateTime: '2024:12:31 23:59:59', zone: '-05:00' }));
  assert.equal(readJpegTakenAt(bytes, 540), '2024-12-31T23:59:59-05:00');
});

test('without OffsetTimeOriginal the fallback offset is formatted as +HH:MM or -HH:MM', () => {
  const little = jpeg(tiffBlock({ little: true, dateTime: '2025:05:01 14:30:00' }));
  assert.equal(readJpegTakenAt(little, 480), '2025-05-01T14:30:00+08:00');
  assert.equal(readJpegTakenAt(little, -300), '2025-05-01T14:30:00-05:00');
  const big = jpeg(tiffBlock({ little: false, dateTime: '2025:05:01 14:30:00' }));
  assert.equal(readJpegTakenAt(big, 330), '2025-05-01T14:30:00+05:30');
  assert.equal(readJpegTakenAt(big, 0), '2025-05-01T14:30:00+00:00');
});

test('a malformed OffsetTimeOriginal is ignored in favour of the fallback', () => {
  const bytes = jpeg(tiffBlock({ little: true, dateTime: '2025:05:01 14:30:00', zone: '+9:00' }));
  assert.equal(readJpegTakenAt(bytes, 480), '2025-05-01T14:30:00+08:00');
});

test('segments before the EXIF block and fill bytes are skipped', () => {
  const bytes = jpeg(tiffBlock({ little: true, dateTime: '2025:05:01 14:30:00', zone: '+09:00' }), jfifWithFill);
  assert.equal(readJpegTakenAt(bytes, 480), '2025-05-01T14:30:00+09:00');
});

test('a JPEG held in a larger buffer is read from its own offset', () => {
  const photo = jpeg(tiffBlock({ little: false, dateTime: '2025:05:01 14:30:00', zone: '+09:00' }));
  const buffer = new Uint8Array(photo.length + 16);
  buffer.set(photo, 16);
  assert.equal(readJpegTakenAt(buffer.subarray(16), 0), '2025-05-01T14:30:00+09:00');
});

test('non-JPEG and empty input return null', () => {
  assert.equal(readJpegTakenAt(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 0), null);
  assert.equal(readJpegTakenAt(new Uint8Array(0), 0), null);
});

test('zeroed, impossible, or missing capture times return null', () => {
  assert.equal(readJpegTakenAt(jpeg(tiffBlock({ little: true, dateTime: '0000:00:00 00:00:00' })), 0), null);
  assert.equal(readJpegTakenAt(jpeg(tiffBlock({ little: true, dateTime: '2025:02:30 10:00:00' })), 0), null);
  assert.equal(readJpegTakenAt(jpeg(tiffBlock({ little: true, dateTime: '2025:05:01 24:00:00' })), 0), null);
  assert.equal(readJpegTakenAt(jpeg(tiffBlock({ little: true, dateTime: '2024:02:29 12:00:00' })), 0), '2024-02-29T12:00:00+00:00');
});

test('a non-finite fallback only matters when the photo has no offset', () => {
  const withZone = jpeg(tiffBlock({ little: true, dateTime: '2025:05:01 14:30:00', zone: '+09:00' }));
  const withoutZone = jpeg(tiffBlock({ little: true, dateTime: '2025:05:01 14:30:00' }));
  assert.equal(readJpegTakenAt(withZone, Number.NaN), '2025-05-01T14:30:00+09:00');
  assert.equal(readJpegTakenAt(withoutZone, Number.NaN), null);
});

test('truncated JPEGs return null or the full answer, and never throw', () => {
  const full = jpeg(tiffBlock({ little: true, dateTime: '2025:05:01 14:30:00', zone: '+09:00' }));
  for (let length = 0; length <= full.length; length++) {
    const result = readJpegTakenAt(full.subarray(0, length), 480);
    assert.ok(result === null || result === '2025-05-01T14:30:00+09:00', `length ${length} returned ${result}`);
  }
  assert.equal(readJpegTakenAt(full.subarray(0, 40), 480), null);
});

test('random bytes after a JPEG signature return null or a well-formed time, and never throw', () => {
  let seed = 12345;
  for (let round = 0; round < 500; round++) {
    const noise = new Uint8Array(96);
    for (let i = 0; i < noise.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      noise[i] = seed & 0xff;
    }
    noise[0] = 0xff;
    noise[1] = 0xd8;
    noise[2] = 0xff;
    const result = readJpegTakenAt(noise, 0);
    assert.ok(result === null || isIsoWithOffset(result), `round ${round} returned ${result}`);
  }
});

test('the bundled browser script is one classic-script IIFE with no module syntax', () => {
  assert.doesNotThrow(() => new Function(captureScript));
  assert.doesNotMatch(captureScript, /^\s*(import|export)\b/m);
});

test('the browser script writes server and photo data with textContent, never innerHTML', () => {
  assert.doesNotMatch(captureScript, /innerHTML|insertAdjacentHTML|document\.write|eval\(/);
  for (const endpoint of ['/api/entries', '/api/media', '/api/related']) assert.ok(captureScript.includes(endpoint), endpoint);
});
