import {
  DISPLAY_EDGE,
  TEXT,
  THUMB_EDGE,
  browserClock,
  checkOriginalSize,
  derivativesOf,
  fitEdges,
  hexOf,
  linkBody,
  mediaPath,
  needsLink,
  photoForm,
  photoOutcome,
  takenAtOf,
} from './capture-logic.ts';
import type { Derivatives, MediaEnvelope, MediaRecord, Phase, Size, UploadResult } from './capture-logic.ts';

/**
 * The photo pipeline for the browser pages: the size check, the SHA-256, the EXIF time, the two preview JPEGs, and the
 * upload that stores the photo and links it to an entry. A page passes its own API client and a progress callback, so
 * any page can add photos the same way. The decisions are in capture-logic.ts; this file decodes and encodes images.
 * Nothing here writes HTML. The page writes each status it is given with textContent.
 */

const JPEG_QUALITY = 0.85;

/** What the pipeline needs from its page: the page's API client, and where each step of an upload is reported. */
export interface PhotoUploadDeps {
  api: <T>(method: string, path: string, body?: FormData | object) => Promise<T>;
  onPhase: (phase: Phase, text: string) => void;
}

/** A saved photo: the server's record, the status text the page shows for it, and the previews that were made. */
export interface UploadedPhoto {
  media: MediaRecord;
  message: string;
  derived: Derivatives | null;
}

// Display and thumbnail JPEGs with the decoded size, or null when this browser cannot decode the photo.
// A browser without createImageBitmap throws at the call, and such a photo gets no previews.
async function derivatives(file: File): Promise<Derivatives | null> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const display = await encodeJpeg(bitmap, fitEdges(bitmap.width, bitmap.height, DISPLAY_EDGE));
    const thumb = await encodeJpeg(bitmap, fitEdges(bitmap.width, bitmap.height, THUMB_EDGE));
    return derivativesOf(bitmap.width, bitmap.height, display, thumb);
  } catch {
    return null;
  } finally {
    if (bitmap !== null) closeBitmap(bitmap);
  }
}

// A JPEG of the bitmap at the given size, or null when this browser gives no 2D context.
function encodeJpeg(bitmap: ImageBitmap, size: Size): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) return Promise.resolve(null);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY); });
}

function closeBitmap(bitmap: ImageBitmap): void {
  if (typeof bitmap.close === 'function') bitmap.close();
}

/**
 * Uploads one photo, linked to memoryId, or unlinked when memoryId is null. The steps are reported through onPhase in
 * order: reading, previewing, uploading, and linking when the server already held the photo unlinked. Throws when a step
 * fails; the caller decides what the photo's row shows.
 */
export async function uploadPhotoFile(file: File, memoryId: string | null, deps: PhotoUploadDeps): Promise<UploadedPhoto> {
  checkOriginalSize(file.size);
  deps.onPhase('working', TEXT.reading);
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const sha256 = hexOf(await crypto.subtle.digest('SHA-256', buffer));
  const taken = takenAtOf(bytes, browserClock);
  deps.onPhase('working', TEXT.previewing);
  const derived = await derivatives(file);
  const body = photoForm(file, sha256, taken, derived, memoryId);
  deps.onPhase('working', TEXT.uploading);
  const result = await deps.api<UploadResult>('POST', '/api/media', body);
  let media = result.media;
  if (needsLink(result)) {
    deps.onPhase('working', TEXT.linking);
    // Both fields are required on every PATCH; the photo's current caption is sent back unchanged.
    const linked = await deps.api<MediaEnvelope>('PATCH', mediaPath(result.media.id), linkBody(result.media, memoryId));
    media = linked.media;
  }
  const message = photoOutcome({ duplicate: result.duplicate, mediaMemoryId: media.memoryId, entryMemoryId: memoryId, derived });
  return { media, message, derived };
}
