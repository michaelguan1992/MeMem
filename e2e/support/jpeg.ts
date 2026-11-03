/** The pixel width and height of a JPEG, read from its start-of-frame marker. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at + 9 <= bytes.length) {
    if (bytes[at] !== 0xff) throw new Error('Not a JPEG: a marker is missing');
    const marker = bytes[at + 1];
    // SOF0 to SOF15, without DHT (0xc4), JPG (0xc8) and DAC (0xcc), which share the range but are not frame headers.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
    }
    at += 2 + view.getUint16(at + 2);
  }
  throw new Error('Not a JPEG: no frame header');
}

/**
 * The bytes with a comment segment just after the start marker. The picture and its EXIF time stay the same, but the bytes,
 * and so the SHA-256, are new. The shared test database keeps one row per hash, so each test's photo must be new.
 */
export function distinctJpeg(bytes: Uint8Array, label: string): Buffer {
  const text = Buffer.from(label, 'utf8');
  const length = text.length + 2;
  const comment = Buffer.concat([Buffer.from([0xff, 0xfe, length >> 8, length & 0xff]), text]);
  return Buffer.concat([bytes.subarray(0, 2), comment, bytes.subarray(2)]);
}

/** The bytes without their EXIF segment, which the fixture has right after the start marker. The picture stays the same. */
export function withoutExif(bytes: Uint8Array): Buffer {
  if (bytes[2] !== 0xff || bytes[3] !== 0xe1) throw new Error('Not a JPEG with EXIF first: the APP1 segment is missing');
  const length = (bytes[4] << 8) | bytes[5];
  return Buffer.concat([bytes.subarray(0, 2), bytes.subarray(4 + length)]);
}
