import type { MemoryInput } from '../core/contracts.ts';
import { MemoryError } from '../core/errors.ts';
import type { MediaEdit, MediaVariant } from '../core/media.ts';
import { currentMemory } from '../core/service.ts';
import { toHex } from '../core/validate.ts';
import type { D1Binding } from '../storage/d1.ts';
import { createCloudflareMedia, createCloudflareMemory } from './cloudflare.ts';
import { PayloadTooLargeError, readBoundedBytes, sameOriginPost } from './http.ts';
import type { R2Binding } from './r2.ts';
import { checkCsrf, readSession } from './web-session.ts';

type ApiEnv = { DB: D1Binding; MEDIA: R2Binding };
type MemoryService = ReturnType<typeof createCloudflareMemory>;
type MediaService = ReturnType<typeof createCloudflareMedia>;
type JsonObject = Record<string, unknown>;

const MiB = 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_UPLOAD_BYTES = 32 * MiB;
const MEDIA_PAGE = 50;
const RELATED_PAGE = 200;
const SUMMARY_CHARS = 200;
const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.status = status; this.code = code;
  }
}
const bad = (message: string): HttpError => new HttpError(400, 'INVALID_INPUT', message);

function fail(status: number, error: string, message?: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(message ? { error, message } : { error }), { status, headers: { ...jsonHeaders, ...headers } });
}
function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}
const notAllowed = (allow: string): Response => fail(405, 'method_not_allowed', 'Method not allowed', { Allow: allow });
// Core error codes pass through; anything unexpected is generic so no internal detail reaches the client.
function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return fail(error.status, error.code, error.message);
  if (error instanceof MemoryError) {
    return fail(error.code === 'INVALID_INPUT' ? 400 : error.code === 'NOT_FOUND' ? 404 : 409, error.code, error.message);
  }
  if (error instanceof PayloadTooLargeError) return fail(413, 'payload_too_large', 'Request body is too large');
  return fail(500, 'unavailable');
}

const mediaType = (request: Request): string | undefined => request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
function parseJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw bad('Request body must be valid JSON'); }
}
/** Accepts only the listed keys; every field is type-checked again by the core service. */
async function jsonBody(request: Request, allowed: string[]): Promise<JsonObject> {
  if (mediaType(request) !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'Expected application/json');
  const body = parseJson(await readBoundedBytes(request, MAX_JSON_BYTES));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Request body must be a JSON object');
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw bad('Request body has an unknown field');
  return body as JsonObject;
}
async function multipart(request: Request): Promise<FormData> {
  if (mediaType(request) !== 'multipart/form-data') throw new HttpError(415, 'unsupported_media_type', 'Expected multipart/form-data');
  try { return await request.formData(); }
  catch { throw bad('Invalid multipart form data'); }
}
function textField(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  if (value === null || value === '') return undefined;
  if (typeof value !== 'string') throw bad(`${name} must be text`);
  return value;
}
function integer(form: FormData, name: string): number | undefined {
  const value = textField(form, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw bad(`${name} must be a decimal integer`);
  return Number(value);
}
async function optionalFile(form: FormData, name: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const value = form.get(name);
  // A browser sends an empty file part for an untouched file input; treat it as absent.
  if (value === null || value === '' || (value instanceof File && value.size === 0)) return undefined;
  if (!(value instanceof File)) throw bad(`${name} must be a file`);
  return new Uint8Array(await value.arrayBuffer());
}

async function createEntry(request: Request, memories: MemoryService): Promise<Response> {
  const { text, occurredAt, relatedIds } = await jsonBody(request, ['text', 'occurredAt', 'relatedIds']);
  const memory = await memories.record({ kind: 'event', text, occurredAt, relatedIds } as MemoryInput);
  return ok({ memory: currentMemory(memory) }, 201);
}
async function relatedPeople(url: URL, memories: MemoryService): Promise<Response> {
  const page = await memories.search({ afterId: url.searchParams.get('afterId') || undefined, limit: RELATED_PAGE });
  const items = page.filter((memory) => memory.kind === 'person' || memory.kind === 'place')
    .map((memory) => ({ id: memory.id, kind: memory.kind, text: [...memory.text].slice(0, SUMMARY_CHARS).join('') }));
  return ok({ items, nextAfterId: page.length === RELATED_PAGE ? page[page.length - 1].id : null });
}
async function listMedia(url: URL, media: MediaService): Promise<Response> {
  const items = await media.list({
    memoryId: url.searchParams.get('memoryId') || undefined,
    afterId: url.searchParams.get('afterId') || undefined,
    limit: MEDIA_PAGE,
  });
  return ok({ items, nextAfterId: items.length === MEDIA_PAGE ? items[items.length - 1].id : null });
}
async function uploadMedia(request: Request, media: MediaService): Promise<Response> {
  const declared = request.headers.get('Content-Length');
  if (!declared || !/^\d+$/.test(declared) || Number(declared) > MAX_UPLOAD_BYTES) {
    // Drop the unread body instead of letting the runtime keep streaming it.
    await request.body?.cancel();
    throw new HttpError(413, 'payload_too_large', 'Uploads must declare a Content-Length of at most 32 MiB');
  }
  const form = await multipart(request);
  const original = form.get('original');
  if (!(original instanceof File)) throw bad('original must be an uploaded photo');
  const originalBytes = new Uint8Array(await original.arrayBuffer());
  const result = await media.upload({
    original: originalBytes,
    display: await optionalFile(form, 'display'),
    thumb: await optionalFile(form, 'thumb'),
    sha256: textField(form, 'sha256') ?? toHex(await crypto.subtle.digest('SHA-256', originalBytes)),
    takenAt: textField(form, 'takenAt'),
    width: integer(form, 'width'),
    height: integer(form, 'height'),
    caption: textField(form, 'caption'),
    memoryId: textField(form, 'memoryId'),
  });
  return ok({ media: result.media, duplicate: result.duplicate }, result.duplicate ? 200 : 201);
}
async function updateMedia(request: Request, media: MediaService, id: string): Promise<Response> {
  const { expectedVersion, memoryId, caption } = await jsonBody(request, ['expectedVersion', 'memoryId', 'caption']);
  const updated = await media.update(id, expectedVersion as number, { memoryId, caption } as MediaEdit);
  return ok({ media: updated });
}
async function deleteMedia(request: Request, media: MediaService, id: string): Promise<Response> {
  const { expectedVersion } = await jsonBody(request, ['expectedVersion']);
  await media.remove(id, expectedVersion as number);
  return ok({ deleted: true, id });
}
async function readMedia(media: MediaService, id: string, variant: MediaVariant): Promise<Response> {
  const object = await media.read(id, variant);
  // Unknown ID, another owner's photo and a missing variant share this response.
  if (!object) return fail(404, 'NOT_FOUND', 'Photo not found');
  // The R2 adapter always yields a stream; a byte array only comes from an in-memory blob double.
  const body = object.body instanceof Uint8Array ? new Uint8Array(object.body) : object.body;
  return new Response(body, { headers: {
    'Content-Type': object.contentType,
    'Cache-Control': 'private, no-store',
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  } });
}

async function dispatch(request: Request, env: ApiEnv, owner: string): Promise<Response> {
  const url = new URL(request.url);
  const session = await readSession(env.DB, request, new Date());
  if (!session || session.owner !== owner) return fail(401, 'unauthorized');
  if (request.method !== 'GET' && (!sameOriginPost(request) || !await checkCsrf(session, request.headers.get('X-CSRF-Token')))) {
    return fail(403, 'forbidden', 'Request origin or CSRF token check failed');
  }
  const memories = createCloudflareMemory(env, owner);
  const media = createCloudflareMedia(env, owner);
  const { pathname } = url;
  const { method } = request;
  if (pathname === '/api/entries') return method === 'POST' ? createEntry(request, memories) : notAllowed('POST');
  if (pathname === '/api/related') return method === 'GET' ? relatedPeople(url, memories) : notAllowed('GET');
  if (pathname === '/api/media') {
    if (method === 'GET') return listMedia(url, media);
    return method === 'POST' ? uploadMedia(request, media) : notAllowed('GET, POST');
  }
  const item = /^\/api\/media\/([^/]+)$/.exec(pathname);
  if (item) {
    if (method === 'PATCH') return updateMedia(request, media, item[1]);
    return method === 'DELETE' ? deleteMedia(request, media, item[1]) : notAllowed('PATCH, DELETE');
  }
  const variant = /^\/api\/media\/([^/]+)\/(original|display|thumb)$/.exec(pathname);
  if (variant) return method === 'GET' ? readMedia(media, variant[1], variant[2] as MediaVariant) : notAllowed('GET');
  return fail(404, 'not_found', 'Not found');
}

/** JSON and multipart API for the owner's own session. Returns null outside /api/. */
export async function handleApi(request: Request, env: ApiEnv, owner: string): Promise<Response | null> {
  if (!new URL(request.url).pathname.startsWith('/api/')) return null;
  try { return await dispatch(request, env, owner); }
  catch (error) { return errorResponse(error); }
}
