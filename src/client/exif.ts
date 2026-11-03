/**
 * Reads the capture time from a JPEG's EXIF block (DateTimeOriginal, with OffsetTimeOriginal when present).
 *
 * Returns an ISO 8601 local time with an offset, for example `2025-05-01T14:30:00+09:00`, or null when the bytes
 * are not a JPEG or the EXIF time is missing or invalid. The offset is the photo's own OffsetTimeOriginal when it
 * has one; otherwise `fallbackOffsetMinutes` (minutes east of UTC) is used. Never throws.
 *
 * The /capture script bundles this module with esbuild. It imports nothing, and every helper is a plain function.
 */
export function readJpegTakenAt(bytes: Uint8Array, fallbackOffsetMinutes: number): string | null {
  try {
    const fields = findCaptureFields(bytes);
    if (fields === null) return null;
    const stamp = parseDateTime(bytes, fields.dateAt, fields.end);
    if (stamp === null) return null;
    const offset = offsetText(bytes, fields, fallbackOffsetMinutes);
    return offset === null ? null : isoText(stamp, offset);
  } catch {
    // Every read is bounds-checked. This catch is a last resort so that the function still never throws.
    return null;
  }
}

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif" and two zero bytes, at the start of an APP1 payload
const IFD_ENTRY_SIZE = 12;
const TAG_EXIF_POINTER = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;

/** Where the TIFF block sits in the file: `start` is the byte-order mark, `end` is the end of the APP1 segment. */
interface TiffSpan {
  start: number;
  end: number;
}

interface Tiff extends TiffSpan {
  view: DataView;
  little: boolean;
}

interface IfdEntry {
  tag: number;
  count: number;
  /** The four bytes after the count: the value itself when it is small, otherwise an offset from the TIFF header. */
  field: number;
  /** Where the value's bytes start in the file. */
  valueAt: number;
}

interface CaptureFields {
  /** Position of the DateTimeOriginal text, or -1 when the photo has none. */
  dateAt: number;
  /** Position of the OffsetTimeOriginal text, or -1 when the photo has none. */
  zoneAt: number;
  /** End of the APP1 segment; every value must lie before it. */
  end: number;
}

// Finds the DateTimeOriginal and OffsetTimeOriginal values through IFD0 and its Exif sub-directory.
function findCaptureFields(bytes: Uint8Array): CaptureFields | null {
  if (!startsLikeJpeg(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const span = findTiffSpan(bytes, view);
  // The 8-byte TIFF header is read with buffer bounds, not segment bounds, so a shorter block stops here.
  if (span === null || span.start + 8 > span.end) return null;
  const little = readByteOrder(bytes, view, span.start);
  if (little === null) return null;
  const entries = readExifDirectory({ view, little, start: span.start, end: span.end });
  return entries === null ? null : { ...captureOffsets(entries), end: span.end };
}

// A JPEG starts with the SOI marker FF D8. A shorter input has no segment after it, so the walk below finds nothing.
function startsLikeJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8;
}

// Walks the JPEG segments before the image data and returns the TIFF block of the first APP1 "Exif" segment.
function findTiffSpan(bytes: Uint8Array, view: DataView): TiffSpan | null {
  let at = 2;
  while (at + 4 <= bytes.byteLength && bytes[at] === 0xff) {
    const next = nextSegment(bytes, view, at);
    if (next < 0) return null;
    if (isExifSegment(bytes, at, next)) return { start: at + 10, end: next };
    at = next;
  }
  return null;
}

// The offset just past the marker or segment at `at`, or -1 when the walk must stop: at the end of the image, at the
// start of the scan data, or at a segment length that runs past the end of the file.
function nextSegment(bytes: Uint8Array, view: DataView, at: number): number {
  const marker = bytes[at + 1];
  if (marker === 0xff) return at + 1; // fill byte before a marker
  if (marker === 0xd9 || marker === 0xda) return -1; // end of image, or start of scan data
  if (hasNoLength(marker)) return at + 2;
  const end = at + 2 + view.getUint16(at + 2);
  return end > bytes.byteLength || end < at + 4 ? -1 : end;
}

// TEM, SOI and RST0 to RST7 are the markers that stand alone, without a length field.
function hasNoLength(marker: number): boolean {
  return marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7);
}

// An APP1 segment (marker E1) whose payload starts with "Exif" and two zero bytes. `end` is just past the segment.
function isExifSegment(bytes: Uint8Array, at: number, end: number): boolean {
  return bytes[at + 1] === 0xe1 && end >= at + 10 && EXIF_HEADER.every((value, i) => bytes[at + 4 + i] === value);
}

// The TIFF byte order: "II" is little-endian and "MM" is big-endian. The header must then hold the number 42.
function readByteOrder(bytes: Uint8Array, view: DataView, start: number): boolean | null {
  const little = bytes[start] === 0x49 && bytes[start + 1] === 0x49;
  const big = bytes[start] === 0x4d && bytes[start + 1] === 0x4d;
  if (!little && !big) return null;
  return view.getUint16(start + 2, little) === 42 ? little : null;
}

// The entries of the Exif sub-directory that IFD0 points to with the Exif pointer tag, or null when it is missing or does not fit.
function readExifDirectory(tiff: Tiff): IfdEntry[] | null {
  // Bytes 4 to 7 of the TIFF header hold the offset of IFD0.
  const ifd0 = readDirectory(tiff, tiff.start + tiff.view.getUint32(tiff.start + 4, tiff.little));
  if (ifd0 === null) return null;
  let pointer = -1;
  for (const entry of ifd0) {
    if (entry.tag === TAG_EXIF_POINTER) pointer = tiff.start + entry.field;
  }
  return pointer < 0 ? null : readDirectory(tiff, pointer);
}

// The entries of the directory at `at` that lie inside the TIFF block, or null when the directory itself does not fit.
function readDirectory(tiff: Tiff, at: number): IfdEntry[] | null {
  if (at + 2 > tiff.end) return null;
  const count = tiff.view.getUint16(at, tiff.little);
  const entries: IfdEntry[] = [];
  for (let i = 0; i < count; i++) {
    const entryAt = at + 2 + i * IFD_ENTRY_SIZE;
    if (entryAt + IFD_ENTRY_SIZE > tiff.end) break;
    entries.push(readEntry(tiff, entryAt));
  }
  return entries;
}

function readEntry(tiff: Tiff, at: number): IfdEntry {
  const count = tiff.view.getUint32(at + 4, tiff.little);
  const field = tiff.view.getUint32(at + 8, tiff.little);
  return {
    tag: tiff.view.getUint16(at, tiff.little),
    count,
    field,
    // Values of four bytes or fewer sit inside the entry; longer values are stored at an offset from the TIFF header.
    valueAt: count <= 4 ? at + 8 : tiff.start + field,
  };
}

// Positions of the DateTimeOriginal and OffsetTimeOriginal values. When a tag repeats, the last entry wins.
function captureOffsets(entries: IfdEntry[]): { dateAt: number; zoneAt: number } {
  let dateAt = -1;
  let zoneAt = -1;
  for (const entry of entries) {
    if (entry.tag === TAG_DATE_TIME_ORIGINAL && entry.count >= 19) dateAt = entry.valueAt;
    if (entry.tag === TAG_OFFSET_TIME_ORIGINAL && entry.count >= 6) zoneAt = entry.valueAt;
  }
  return { dateAt, zoneAt };
}

// DateTimeOriginal is "YYYY:MM:DD HH:MM:SS". An all-zero value means the camera never set its clock.
function parseDateTime(bytes: Uint8Array, at: number, end: number): RegExpExecArray | null {
  if (at < 0 || at + 19 > end) return null;
  const stamp = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(asciiAt(bytes, at, 19));
  if (stamp === null) return null;
  const [year, month, day, hour, minute, second] = stamp.slice(1).map(Number);
  return isValidDate(year, month, day) && isValidTime(hour, minute, second) ? stamp : null;
}

function isValidDate(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isValidTime(hour: number, minute: number, second: number): boolean {
  return hour <= 23 && minute <= 59 && second <= 59;
}

// OffsetTimeOriginal is "+HH:MM" or "-HH:MM". Anything else falls back to the caller's offset.
function offsetText(bytes: Uint8Array, fields: CaptureFields, fallbackOffsetMinutes: number): string | null {
  const zone = fields.zoneAt >= 0 && fields.zoneAt + 6 <= fields.end
    ? /^([+-])(\d{2}):(\d{2})/.exec(asciiAt(bytes, fields.zoneAt, 6))
    : null;
  if (zone !== null && Number(zone[2]) <= 23 && Number(zone[3]) <= 59) return zone[1] + zone[2] + ':' + zone[3];
  return formatOffset(fallbackOffsetMinutes);
}

// Minutes east of UTC as "+HH:MM" or "-HH:MM". Null unless the value is finite and within one day.
function formatOffset(minutes: number): string | null {
  const whole = Math.round(minutes);
  if (!Number.isFinite(whole) || Math.abs(whole) > 1439) return null;
  const magnitude = Math.abs(whole);
  return (whole < 0 ? '-' : '+') + twoDigits(Math.floor(magnitude / 60)) + ':' + twoDigits(magnitude % 60);
}

function twoDigits(value: number): string {
  return ('0' + value).slice(-2);
}

// "YYYY-MM-DDTHH:MM:SS" from the parsed stamp, followed by the offset.
function isoText(stamp: RegExpExecArray, offset: string): string {
  return stamp[1] + '-' + stamp[2] + '-' + stamp[3] + 'T' + stamp[4] + ':' + stamp[5] + ':' + stamp[6] + offset;
}

// The text of `length` bytes from `at`. Callers have checked that those bytes lie inside the file.
function asciiAt(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}
