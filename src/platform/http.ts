export const htmlEscape = (value: string): string => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
export class PayloadTooLargeError extends Error {}
export async function readBoundedForm(request: Request, maximumBytes: number): Promise<URLSearchParams> {
  const type = request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') throw new Error('Expected URL-encoded form data');
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new PayloadTooLargeError();
  const reader = request.body?.getReader();
  if (!reader) return new URLSearchParams();
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
  return new URLSearchParams(new TextDecoder().decode(body));
}
export function sameOriginPost(request: Request): boolean {
  const origin = request.headers.get('Origin');
  return Boolean(origin && origin === new URL(request.url).origin);
}
