export const htmlEscape = (value: string): string => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
export class PayloadTooLargeError extends Error {}
/** Reads the whole body; fails fast on a declared Content-Length, or once the streamed bytes pass maximumBytes. */
export async function readBoundedBytes(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new PayloadTooLargeError();
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}
export async function readBoundedForm(request: Request, maximumBytes: number): Promise<URLSearchParams> {
  const type = request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') throw new Error('Expected URL-encoded form data');
  return new URLSearchParams(new TextDecoder().decode(await readBoundedBytes(request, maximumBytes)));
}
/** A form the handler refuses, with the message and status to send instead. */
export interface FormRefusal { message: string; status: number }
/** A bounded URL-encoded form, or the refusal to send: 413 when the body is over the limit, 400 for any other failure. */
export async function readFormOrRefusal(request: Request, maximumBytes: number): Promise<URLSearchParams | FormRefusal> {
  try { return await readBoundedForm(request, maximumBytes); }
  catch (error) {
    return error instanceof PayloadTooLargeError ? { message: 'Request too large.', status: 413 } : { message: 'Invalid form.', status: 400 };
  }
}
export function sameOriginPost(request: Request): boolean {
  const origin = request.headers.get('Origin');
  return Boolean(origin && origin === new URL(request.url).origin);
}
