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

// Byte layouts for the boundary tests. A segment is its marker, a two-byte length that counts itself, and its payload.
const SOI = [0xff, 0xd8];
const SOS = [0xff, 0xda, 0x00, 0x02];
const EOI = [0xff, 0xd9];
const segment = (marker: number, payload: number[]): number[] => [0xff, marker, ...u16(payload.length + 2, false), ...payload];
const exifSegment = (tiff: number[]): number[] => segment(0xe1, [...ascii('Exif'), 0, 0, ...tiff]);
const file = (...parts: number[][]): Uint8Array => Uint8Array.from([...SOI, ...parts.flat()]);

interface Field {
  tag: number;
  count: number;
  text: string;
  /** Written after the Exif segment rather than inside it. The segment's length does not cover these bytes. */
  outside?: boolean;
}

/**
 * A TIFF block whose Exif sub-IFD lists `fields` in order. Each field's text follows the IFD, and an `outside` text goes
 * to `tail` instead, which the caller places just after the Exif segment. `ifdCount` sets the count the IFD declares.
 */
function exifTiffParts(options: { little?: boolean; mark?: string; magic?: number; ifdCount?: number; fields: Field[] }): { tiff: number[]; tail: number[] } {
  const little = options.little ?? true;
  const exifAt = 8 + 2 + 12 + 4;
  const tableEnd = exifAt + 2 + options.fields.length * 12 + 4;
  const insideLength = options.fields.reduce((sum, field) => sum + (field.outside ? 0 : field.text.length), 0);
  let insideAt = tableEnd;
  let tailAt = tableEnd + insideLength;
  const insideTexts: number[][] = [];
  const tailTexts: number[][] = [];
  const entries = options.fields.map((field) => {
    const text = ascii(field.text);
    const offset = field.outside ? tailAt : insideAt;
    if (field.outside) { tailAt += text.length; tailTexts.push(text); } else { insideAt += text.length; insideTexts.push(text); }
    return [...u16(field.tag, little), ...u16(2, little), ...u32(field.count, little), ...u32(offset, little)];
  });
  const tiff = [
    ...ascii(options.mark ?? (little ? 'II' : 'MM')), ...u16(options.magic ?? 42, little), ...u32(8, little),
    ...u16(1, little), ...u16(0x8769, little), ...u16(4, little), ...u32(1, little), ...u32(exifAt, little), ...u32(0, little),
    ...u16(options.ifdCount ?? options.fields.length, little),
    ...entries.flat(),
    ...u32(0, little),
    ...insideTexts.flat(),
  ];
  return { tiff, tail: tailTexts.flat() };
}

const DATE_TIME = '2025:05:01 14:30:00';
const dateField = (text = DATE_TIME, count = text.length + 1): Field => ({ tag: 0x9003, count, text: text + '\0' });
const zoneField = (text = '+09:00', count = text.length + 1): Field => ({ tag: 0x9011, count, text: text + '\0' });
const exifOnly = (fields: Field[]): Uint8Array => file(exifSegment(exifTiffParts({ fields }).tiff));

test('markers with no length (TEM, RST0 to RST7, SOI) are skipped before the Exif segment', () => {
  const bytes = file([0xff, 0x01], [0xff, 0xd0], [0xff, 0xd7], [0xff, 0xd8], exifSegment(exifTiffParts({ fields: [dateField()] }).tiff));
  assert.equal(readJpegTakenAt(bytes, 0), '2025-05-01T14:30:00+00:00');
});

test('end of image and start of scan end the search, so a segment after them is not read', () => {
  const tiff = exifTiffParts({ fields: [dateField()] }).tiff;
  assert.equal(readJpegTakenAt(file([0xff, 0xd9, 0x00, 0x02], exifSegment(tiff)), 0), null);
  assert.equal(readJpegTakenAt(file(SOS, exifSegment(tiff)), 0), null);
});

test('a byte that is not a marker where one is expected ends the search', () => {
  assert.equal(readJpegTakenAt(file([0x00], exifSegment(exifTiffParts({ fields: [dateField()] }).tiff)), 0), null);
});

test('a zero-length segment is walked past, and a length too short to hold itself ends the search', () => {
  const tiff = exifTiffParts({ fields: [dateField()] }).tiff;
  assert.equal(readJpegTakenAt(file([0xff, 0xe0, 0x00, 0x02], exifSegment(tiff)), 0), '2025-05-01T14:30:00+00:00');
  assert.equal(readJpegTakenAt(file([0xff, 0xe0, 0x00, 0x01], exifSegment(tiff)), 0), null);
});

test('a segment that ends exactly at the end of the file is read', () => {
  assert.equal(readJpegTakenAt(exifOnly([dateField()]), 0), '2025-05-01T14:30:00+00:00');
});

test('only an APP1 segment with the Exif header holds the capture time', () => {
  const other = segment(0xe2, [...ascii('Exif'), 0, 0, ...exifTiffParts({ fields: [dateField('2001:01:01 00:00:00')] }).tiff]);
  assert.equal(readJpegTakenAt(file(other, exifSegment(exifTiffParts({ fields: [dateField()] }).tiff)), 0), '2025-05-01T14:30:00+00:00');
});

test('an APP1 segment too short to hold the Exif header is skipped', () => {
  const short = segment(0xe1, ascii('Exif'));
  assert.equal(readJpegTakenAt(file(short, exifSegment(exifTiffParts({ fields: [dateField()] }).tiff)), 0), '2025-05-01T14:30:00+00:00');
});

test('the first Exif segment decides, even when it holds no TIFF data', () => {
  const empty = segment(0xe1, [...ascii('Exif'), 0, 0]);
  assert.equal(readJpegTakenAt(file(empty, exifSegment(exifTiffParts({ fields: [dateField()] }).tiff)), 0), null);
});

test('the TIFF byte-order mark must be II or MM', () => {
  assert.equal(readJpegTakenAt(file(exifSegment(exifTiffParts({ little: true, mark: 'IM', fields: [dateField()] }).tiff)), 0), null);
  assert.equal(readJpegTakenAt(file(exifSegment(exifTiffParts({ little: false, mark: 'MI', fields: [dateField()] }).tiff)), 0), null);
});

test('the TIFF magic number must be 42', () => {
  for (const magic of [41, 43]) assert.equal(readJpegTakenAt(file(exifSegment(exifTiffParts({ magic, fields: [dateField()] }).tiff)), 0), null, `magic ${magic}`);
});

test('an entry past the directory count is not read', () => {
  const tiff = exifTiffParts({ ifdCount: 1, fields: [dateField(), zoneField()] }).tiff;
  assert.equal(readJpegTakenAt(file(exifSegment(tiff)), 480), '2025-05-01T14:30:00+08:00');
});

test('a DateTimeOriginal shorter than 19 characters is ignored, so the earlier one stays', () => {
  const tiff = exifTiffParts({ fields: [dateField(), { tag: 0x9003, count: 18, text: '2000:01:01 00:00:00\0' }] }).tiff;
  assert.equal(readJpegTakenAt(file(exifSegment(tiff)), 0), '2025-05-01T14:30:00+00:00');
});

test('a DateTimeOriginal of exactly 19 characters is read, with no terminating NUL', () => {
  assert.equal(readJpegTakenAt(exifOnly([{ tag: 0x9003, count: 19, text: DATE_TIME }]), 0), '2025-05-01T14:30:00+00:00');
});

test('other tags with long values do not replace DateTimeOriginal', () => {
  const description = { tag: 0x010e, count: 30, text: 'x'.repeat(29) + '\0' };
  assert.equal(readJpegTakenAt(exifOnly([dateField(), description]), 0), '2025-05-01T14:30:00+00:00');
});

test('an OffsetTimeOriginal of exactly six characters is the photo offset', () => {
  assert.equal(readJpegTakenAt(exifOnly([dateField(), { tag: 0x9011, count: 6, text: '+09:00' }]), 480), '2025-05-01T14:30:00+09:00');
});

test('an OffsetTimeOriginal shorter than six characters is ignored', () => {
  assert.equal(readJpegTakenAt(exifOnly([dateField(), { tag: 0x9011, count: 5, text: '+09:00\0' }]), 480), '2025-05-01T14:30:00+08:00');
});

test('a DateTimeOriginal that runs past the end of the Exif segment gives no time', () => {
  const { tiff, tail } = exifTiffParts({ fields: [{ ...dateField(), outside: true }] });
  assert.equal(readJpegTakenAt(file(exifSegment(tiff), tail), 0), null);
});

test('an OffsetTimeOriginal that runs past the end of the Exif segment is ignored', () => {
  const { tiff, tail } = exifTiffParts({ fields: [dateField(), { ...zoneField(), outside: true }] });
  assert.equal(readJpegTakenAt(file(exifSegment(tiff), tail), 480), '2025-05-01T14:30:00+08:00');
});

test('calendar and clock fields are checked at both ends of their ranges', () => {
  const cases: Array<[string, string | null]> = [
    ['2025:01:01 00:00:00', '2025-01-01T00:00:00+00:00'],
    ['2025:12:31 23:59:59', '2025-12-31T23:59:59+00:00'],
    ['2025:00:15 10:00:00', null],
    ['2025:13:01 10:00:00', null],
    ['2025:05:00 10:00:00', null],
    ['2025:04:31 10:00:00', null],
    ['2025:02:29 10:00:00', null],
    ['2025:05:01 24:00:00', null],
    ['2025:05:01 23:60:00', null],
    ['2025:05:01 23:59:60', null],
  ];
  for (const [text, expected] of cases) assert.equal(readJpegTakenAt(exifOnly([dateField(text)]), 0), expected, text);
});

test('an OffsetTimeOriginal is used only when hours are at most 23 and minutes at most 59', () => {
  assert.equal(readJpegTakenAt(exifOnly([dateField(), zoneField('+23:59')]), 480), '2025-05-01T14:30:00+23:59');
  assert.equal(readJpegTakenAt(exifOnly([dateField(), zoneField('+24:00')]), 480), '2025-05-01T14:30:00+08:00');
  assert.equal(readJpegTakenAt(exifOnly([dateField(), zoneField('+09:60')]), 480), '2025-05-01T14:30:00+08:00');
});

test('a fallback offset must be within one day', () => {
  const noZone = exifOnly([dateField()]);
  assert.equal(readJpegTakenAt(noZone, 1439), '2025-05-01T14:30:00+23:59');
  assert.equal(readJpegTakenAt(noZone, -1439), '2025-05-01T14:30:00-23:59');
  assert.equal(readJpegTakenAt(noZone, 1440), null);
  assert.equal(readJpegTakenAt(noZone, -1440), null);
});

test('a file cut off at or after the end of its Exif segment still gives the time', () => {
  const bytes = file(exifSegment(exifTiffParts({ fields: [dateField(), zoneField()] }).tiff), SOS, EOI);
  const exifEnd = bytes.length - SOS.length - EOI.length;
  for (let length = exifEnd; length <= bytes.length; length++) {
    assert.equal(readJpegTakenAt(bytes.subarray(0, length), 480), '2025-05-01T14:30:00+09:00', `length ${length}`);
  }
});

test('bytes that do not start with the SOI marker are refused, even when an Exif segment follows', () => {
  const exif = exifSegment(exifTiffParts({ fields: [dateField()] }).tiff);
  assert.equal(readJpegTakenAt(Uint8Array.from([0x00, 0xd8, ...exif]), 0), null);
  assert.equal(readJpegTakenAt(Uint8Array.from([0xff, 0x00, ...exif]), 0), null);
});

test('a DateTimeOriginal in IFD0, rather than in the Exif sub-directory, gives no time', () => {
  // The IFD sits at TIFF offset 12 or 13, so that a read of the file's own bytes from offset 1 would land on its entry.
  for (const ifdAt of [12, 13]) {
    const tiff = [
      ...ascii('II'), ...u16(42, true), ...u32(ifdAt, true), ...new Array<number>(ifdAt - 8).fill(0),
      ...u16(1, true), ...u16(0x9003, true), ...u16(2, true), ...u32(20, true), ...u32(ifdAt + 18, true), ...u32(0, true),
      ...ascii(DATE_TIME + '\0'),
    ];
    assert.equal(readJpegTakenAt(file(exifSegment(tiff)), 0), null, `IFD at ${ifdAt}`);
  }
});

// One little-endian DateTimeOriginal entry (20 characters) whose text is at `valueAt`.
const dateEntryAt = (valueAt: number): number[] => [...u16(0x9003, true), ...u16(2, true), ...u32(20, true), ...u32(valueAt, true)];
// A TIFF with the date text at TIFF offset 26 and the Exif sub-IFD at 46, which declares `count` entries and holds `entries`.
function tiffWithEntries(entries: number[][], count: number): number[] {
  return [
    ...ascii('II'), ...u16(42, true), ...u32(8, true),
    ...u16(1, true), ...u16(0x8769, true), ...u16(4, true), ...u32(1, true), ...u32(46, true), ...u32(0, true),
    ...ascii(DATE_TIME + '\0'),
    ...u16(count, true), ...entries.flat(),
  ];
}

test('an entry that ends exactly at the end of the Exif segment is read', () => {
  const tiff = tiffWithEntries([dateEntryAt(26)], 1);
  assert.equal(readJpegTakenAt(file(exifSegment(tiff)), 0), '2025-05-01T14:30:00+00:00');
});

test('an entry that runs past the end of the Exif segment is not read', () => {
  // The second entry starts at TIFF offset 60 and would end at 72; the segment ends at 66, inside it.
  const tiff = tiffWithEntries([dateEntryAt(26), dateEntryAt(0)], 2).slice(0, 66);
  assert.equal(readJpegTakenAt(file(exifSegment(tiff)), 0), '2025-05-01T14:30:00+00:00');
});
