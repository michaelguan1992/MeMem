// Writes e2e/fixtures/exif-photo.jpg: a 2400x1600 JPEG whose EXIF says it was taken at 2024:05:01 14:30:00 +09:00.
// Chrome draws and encodes the picture, and this script adds the EXIF block. Run once with
// `node e2e/fixtures/make-exif-photo.mjs`; the output is committed, so the test never regenerates it.
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const output = resolve(dirname(fileURLToPath(import.meta.url)), 'exif-photo.jpg');
const DATE_TIME_ORIGINAL = '2024:05:01 14:30:00';
const OFFSET_TIME_ORIGINAL = '+09:00';

// Big-endian TIFF with IFD0 -> Exif IFD, holding DateTimeOriginal (0x9003) and OffsetTimeOriginal (0x9011).
function exifSegment() {
  const date = Buffer.from(`${DATE_TIME_ORIGINAL}\0`, 'ascii');
  const offset = Buffer.from(`${OFFSET_TIME_ORIGINAL}\0`, 'ascii');
  const ifd0At = 8;
  const exifAt = ifd0At + 2 + 12 + 4;
  const dateAt = exifAt + 2 + 2 * 12 + 4;
  const offsetAt = dateAt + date.length;
  const tiff = Buffer.alloc(offsetAt + offset.length);
  tiff.write('MM', 0, 'ascii');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(ifd0At, 4);
  tiff.writeUInt16BE(1, ifd0At);
  writeEntry(tiff, ifd0At + 2, 0x8769, 4, 1, exifAt);
  tiff.writeUInt32BE(0, ifd0At + 14);
  tiff.writeUInt16BE(2, exifAt);
  writeEntry(tiff, exifAt + 2, 0x9003, 2, date.length, dateAt);
  writeEntry(tiff, exifAt + 14, 0x9011, 2, offset.length, offsetAt);
  tiff.writeUInt32BE(0, exifAt + 26);
  date.copy(tiff, dateAt);
  offset.copy(tiff, offsetAt);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const length = payload.length + 2;
  return Buffer.concat([Buffer.from([0xff, 0xe1, length >> 8, length & 0xff]), payload]);
}
function writeEntry(buffer, at, tag, type, count, valueOrOffset) {
  buffer.writeUInt16BE(tag, at);
  buffer.writeUInt16BE(type, at + 2);
  buffer.writeUInt32BE(count, at + 4);
  buffer.writeUInt32BE(valueOrOffset, at + 8);
}

const browser = await chromium.launch({ channel: 'chrome' });
let encoded;
try {
  const page = await browser.newPage();
  encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2400;
    canvas.height = 1600;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d canvas context');
    const sky = context.createLinearGradient(0, 0, 0, 1600);
    sky.addColorStop(0, '#8fb8de');
    sky.addColorStop(1, '#f2d7a6');
    context.fillStyle = sky;
    context.fillRect(0, 0, 2400, 1600);
    context.fillStyle = '#2d6a5a';
    context.beginPath();
    context.moveTo(0, 1100);
    context.lineTo(800, 620);
    context.lineTo(1500, 1000);
    context.lineTo(2400, 700);
    context.lineTo(2400, 1600);
    context.lineTo(0, 1600);
    context.closePath();
    context.fill();
    context.fillStyle = '#c0583b';
    context.beginPath();
    context.arc(1900, 360, 140, 0, Math.PI * 2);
    context.fill();
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
  });
} finally {
  await browser.close();
}

const jpeg = Buffer.from(encoded, 'base64');
if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Chrome did not return a JPEG');
await writeFile(output, Buffer.concat([jpeg.subarray(0, 2), exifSegment(), jpeg.subarray(2)]));
console.log(`wrote ${output} (${jpeg.length + exifSegment().length} bytes) with EXIF ${DATE_TIME_ORIGINAL} ${OFFSET_TIME_ORIGINAL}`);
