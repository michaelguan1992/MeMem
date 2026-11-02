/**
 * Reads the capture time from a JPEG's EXIF block (DateTimeOriginal, with OffsetTimeOriginal when present).
 *
 * Returns an ISO 8601 local time with an offset, for example `2025-05-01T14:30:00+09:00`, or null when the bytes
 * are not a JPEG or the EXIF time is missing or invalid. The offset is the photo's own OffsetTimeOriginal when it
 * has one; otherwise `fallbackOffsetMinutes` (minutes east of UTC) is used. Never throws.
 *
 * capture-client.ts embeds this function's source text with Function.prototype.toString(), so the body must stay
 * self-contained: no imports, no module-level helpers, and no nested named or arrow functions. The bundler's
 * keepNames option would add a reference to a helper that does not exist in the browser.
 */
export function readJpegTakenAt(bytes: Uint8Array, fallbackOffsetMinutes: number): string | null {
  try {
    const size = bytes.byteLength;
    if (size < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, size);

    // Walk the JPEG segments until the image data starts, looking for the APP1 block that holds "Exif\0\0".
    let tiff = -1;
    let tiffEnd = -1;
    let at = 2;
    while (tiff < 0 && at + 4 <= size && bytes[at] === 0xff) {
      const marker = bytes[at + 1];
      if (marker === 0xff) { at += 1; continue; } // fill byte before a marker
      if (marker === 0xd9 || marker === 0xda) break; // end of image, or start of scan data
      if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; } // no length field
      const end = at + 2 + view.getUint16(at + 2);
      if (end > size || end < at + 4) break;
      const isExif = marker === 0xe1 && end >= at + 10 && bytes[at + 4] === 0x45 && bytes[at + 5] === 0x78
        && bytes[at + 6] === 0x69 && bytes[at + 7] === 0x66 && bytes[at + 8] === 0 && bytes[at + 9] === 0;
      if (isExif) { tiff = at + 10; tiffEnd = end; }
      at = end;
    }
    if (tiff < 0 || tiff + 8 > tiffEnd) return null;

    // TIFF header: byte order ("II" little-endian or "MM" big-endian), the number 42, then the offset of IFD0.
    const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
    if (!little && !(bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d)) return null;
    if (view.getUint16(tiff + 2, little) !== 42) return null;

    // IFD0 points to the Exif sub-directory, which holds DateTimeOriginal and OffsetTimeOriginal.
    let directory = tiff + view.getUint32(tiff + 4, little);
    let exifDirectory = -1;
    let dateAt = -1;
    let zoneAt = -1;
    for (let pass = 0; pass < 2; pass++) {
      if (directory + 2 > tiffEnd) return null;
      const entries = view.getUint16(directory, little);
      for (let i = 0; i < entries; i++) {
        const entry = directory + 2 + i * 12;
        if (entry + 12 > tiffEnd) break;
        const tag = view.getUint16(entry, little);
        const count = view.getUint32(entry + 4, little);
        // Values of four bytes or fewer sit inside the entry; longer values are stored at an offset from the TIFF header.
        const valueAt = count <= 4 ? entry + 8 : tiff + view.getUint32(entry + 8, little);
        if (pass === 0 && tag === 0x8769) exifDirectory = tiff + view.getUint32(entry + 8, little);
        if (pass === 1 && tag === 0x9003 && count >= 19) dateAt = valueAt;
        if (pass === 1 && tag === 0x9011 && count >= 6) zoneAt = valueAt;
      }
      if (pass === 0) {
        if (exifDirectory < 0) return null;
        directory = exifDirectory;
      }
    }

    // DateTimeOriginal is "YYYY:MM:DD HH:MM:SS"; an all-zero value means the camera never set the clock.
    if (dateAt < 0 || dateAt + 19 > tiffEnd) return null;
    const stamp = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String.fromCharCode(...bytes.subarray(dateAt, dateAt + 19)));
    if (!stamp) return null;
    const [year, month, day, hour, minute, second] = stamp.slice(1).map(Number);
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
    if (hour > 23 || minute > 59 || second > 59) return null;

    // OffsetTimeOriginal is "+HH:MM" or "-HH:MM"; anything else falls back to the caller's offset.
    const zone = zoneAt >= 0 && zoneAt + 6 <= tiffEnd
      ? /^([+-])(\d{2}):(\d{2})/.exec(String.fromCharCode(...bytes.subarray(zoneAt, zoneAt + 6)))
      : null;
    let offset: string;
    if (zone && Number(zone[2]) <= 23 && Number(zone[3]) <= 59) {
      offset = zone[1] + zone[2] + ':' + zone[3];
    } else {
      const minutes = Math.round(fallbackOffsetMinutes);
      if (!Number.isFinite(minutes) || Math.abs(minutes) > 1439) return null;
      const magnitude = Math.abs(minutes);
      offset = (minutes < 0 ? '-' : '+') + ('0' + Math.floor(magnitude / 60)).slice(-2) + ':' + ('0' + (magnitude % 60)).slice(-2);
    }
    return stamp[1] + '-' + stamp[2] + '-' + stamp[3] + 'T' + stamp[4] + ':' + stamp[5] + ':' + stamp[6] + offset;
  } catch {
    return null;
  }
}
