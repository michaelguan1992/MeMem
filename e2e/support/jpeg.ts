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
