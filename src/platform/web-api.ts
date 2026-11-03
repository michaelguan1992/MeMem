import { z } from 'zod';
import { sha256Hex } from '../core/media.ts';
import { MemoryError } from '../core/errors.ts';
import {
  mediaEditFields, mediaIdSchema, mediaVariantSchema, MAX_PAGE_LIMIT, MEDIA_VARIANTS, memoryFields, memoryIdSchema, parse,
  relatedIdList, versionSchema, type MediaVariant,
} from '../core/schema.ts';
import { currentMemory } from '../core/service.ts';
import type { D1Binding } from '../storage/d1.ts';
import { createCloudflareMedia, createCloudflareMemory } from './cloudflare.ts';
import { PayloadTooLargeError, readBoundedBytes, sameOriginPost } from './http.ts';
import type { R2Binding } from './r2.ts';
import { checkCsrf, readSession, type WebSession } from './web-session.ts';

type ApiEnv = { DB: D1Binding; MEDIA: R2Binding };
type MemoryService = ReturnType<typeof createCloudflareMemory>;
type MediaService = ReturnType<typeof createCloudflareMedia>;

const MiB = 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_UPLOAD_BYTES = 32 * MiB;
const MEDIA_PAGE = 50;
const SUMMARY_CHARS = 200;
const variantPath = new RegExp(`^/api/media/([^/]+)/(${MEDIA_VARIANTS.join('|')})$`);
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

const mediaType = (request: Request): string | undefined => request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
function parseJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw bad('Request body must be valid JSON'); }
}

// A JSON body is a strict object of the core fields it names. Unknown keys and non-objects are refused with the
// messages this API has always returned; a wrong value is refused with the message of the rule it breaks.
const UNKNOWN_FIELD = 'Request body has an unknown field';
const NOT_AN_OBJECT = 'Request body must be a JSON object';
const jsonObject = <Shape extends z.ZodRawShape>(shape: Shape) => z.strictObject(shape, {
  error: (issue) => (issue.code === 'unrecognized_keys' ? UNKNOWN_FIELD : NOT_AN_OBJECT),
});
const entryBody = jsonObject({
  id: memoryIdSchema.optional(),
  text: memoryFields.text,
  occurredAt: memoryFields.occurredAt,
  // The capture page never sends null here, but null has always meant "no links" on this endpoint.
  relatedIds: relatedIdList.nullish(),
});
// An edit of an event. An absent occurredAt is stored as null (unknown time), as every write does; absent or null relatedIds mean no links.
const entryEditBody = jsonObject({
  expectedVersion: versionSchema,
  text: memoryFields.text,
  occurredAt: memoryFields.occurredAt,
  relatedIds: relatedIdList.nullish(),
});
const mediaEditBody = jsonObject({ expectedVersion: versionSchema, ...mediaEditFields });
const expectedVersionBody = jsonObject({ expectedVersion: versionSchema });

async function jsonBody<Schema extends z.ZodType>(request: Request, schema: Schema): Promise<z.output<Schema>> {
  if (mediaType(request) !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'Expected application/json');
  return parse(schema, parseJson(await readBoundedBytes(request, MAX_JSON_BYTES)));
}
async function multipart(request: Request): Promise<FormData> {
  if (mediaType(request) !== 'multipart/form-data') throw new HttpError(415, 'unsupported_media_type', 'Expected multipart/form-data');
  try { return await request.formData(); }
  catch { throw bad('Invalid multipart form data'); }
}

// Form fields. An empty field is absent, and a browser sends an empty file part for an untouched file input.
const absentText = (value: unknown) => (value === null || value === '' ? undefined : value);
const absentFile = (value: unknown) => (value === null || value === '' || (value instanceof File && value.size === 0) ? undefined : value);
const textField = (name: string) => z.preprocess(absentText, z.string({ error: `${name} must be text` }).optional());
const fileField = (name: string) => z.preprocess(absentFile, z.instanceof(File, { error: `${name} must be a file` }).optional());
const integerField = (name: string) => z.preprocess(absentText, z.string({ error: `${name} must be text` })
  .regex(/^\d+$/, { error: `${name} must be a decimal integer` })
  .refine((text) => Number.isSafeInteger(Number(text)), { error: `${name} must be a decimal integer` })
  .transform(Number)
  .optional());
const uploadFields = {
  original: z.instanceof(File, { error: 'original must be an uploaded photo' }),
  display: fileField('display'),
  thumb: fileField('thumb'),
  sha256: textField('sha256'),
  takenAt: textField('takenAt'),
  width: integerField('width'),
  height: integerField('height'),
  caption: textField('caption'),
  memoryId: textField('memoryId'),
};
const uploadForm = z.object(uploadFields);
const bytesOf = async (file: File): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await file.arrayBuffer());

async function createEntry(request: Request, memories: MemoryService): Promise<Response> {
  const { id, relatedIds, ...entry } = await jsonBody(request, entryBody);
  // The client-chosen id is checked by the core service; a retry with the same id replays the entry.
  const memory = await memories.record({ kind: 'event', ...entry, relatedIds: relatedIds ?? undefined }, id);
  return ok({ memory: currentMemory(memory) }, 201);
}
async function listEntries(url: URL, memories: MemoryService): Promise<Response> {
  const page = await memories.search({ afterId: url.searchParams.get('afterId') || undefined, limit: MAX_PAGE_LIMIT });
  // The page is cut by ID before its events are picked out, so it can hold fewer events than the limit; the cursor still follows the whole page.
  const items = page.filter((memory) => memory.kind === 'event').map(currentMemory);
  return ok({ items, nextAfterId: page.length === MAX_PAGE_LIMIT ? page[page.length - 1].id : null });
}
async function updateEntry(request: Request, memories: MemoryService, id: string): Promise<Response> {
  const { expectedVersion, text, occurredAt, relatedIds } = await jsonBody(request, entryEditBody);
  // Only an event is edited here, so a person, place or fact at this ID is reported as missing, like an unknown ID.
  if ((await memories.get(id))?.kind !== 'event') throw new MemoryError('NOT_FOUND', 'Entry not found');
  const updated = await memories.correct(id, expectedVersion, { kind: 'event', text, occurredAt, relatedIds: relatedIds ?? undefined });
  return ok({ memory: currentMemory(updated) });
}
async function relatedPeople(url: URL, memories: MemoryService): Promise<Response> {
  const page = await memories.search({ afterId: url.searchParams.get('afterId') || undefined, limit: MAX_PAGE_LIMIT });
  const items = page.filter((memory) => memory.kind === 'person' || memory.kind === 'place')
    .map((memory) => ({ id: memory.id, kind: memory.kind, text: [...memory.text].slice(0, SUMMARY_CHARS).join('') }));
  return ok({ items, nextAfterId: page.length === MAX_PAGE_LIMIT ? page[page.length - 1].id : null });
}
// The memory filter of GET /api/media: one memory's photos, the photos no memory holds (unlinked=1), or no filter at all.
function memoryFilter(url: URL): { memoryId?: string | null } {
  const memoryId = url.searchParams.get('memoryId') || undefined;
  const unlinked = url.searchParams.getAll('unlinked');
  if (unlinked.length === 0) return { memoryId };
  if (unlinked.some((value) => value !== '1')) throw bad('unlinked must be 1');
  if (memoryId !== undefined) throw bad('Use memoryId or unlinked, not both');
  return { memoryId: null };
}
async function listMedia(url: URL, media: MediaService): Promise<Response> {
  const items = await media.list({
    ...memoryFilter(url),
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
  // Only the names in uploadFields are read from the form.
  const fields = parse(uploadForm, Object.fromEntries(Object.keys(uploadFields).map((name) => [name, form.get(name)])));
  const original = await bytesOf(fields.original);
  const display = fields.display === undefined ? undefined : await bytesOf(fields.display);
  const thumb = fields.thumb === undefined ? undefined : await bytesOf(fields.thumb);
  const result = await media.upload({
    original, display, thumb,
    sha256: fields.sha256 ?? await sha256Hex(original),
    takenAt: fields.takenAt, width: fields.width, height: fields.height, caption: fields.caption, memoryId: fields.memoryId,
  });
  return ok({ media: result.media, duplicate: result.duplicate }, result.duplicate ? 200 : 201);
}
async function updateMedia(request: Request, media: MediaService, id: string): Promise<Response> {
  const { expectedVersion, memoryId, caption } = await jsonBody(request, mediaEditBody);
  const updated = await media.update(id, expectedVersion, { memoryId, caption });
  return ok({ media: updated });
}
async function deleteMedia(request: Request, media: MediaService, id: string): Promise<Response> {
  const { expectedVersion } = await jsonBody(request, expectedVersionBody);
  await media.remove(id, expectedVersion);
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

/** What a route handler receives: the request, its parsed URL, and the owner's services. */
interface ApiCall {
  request: Request;
  url: URL;
  memories: MemoryService;
  media: MediaService;
}
/** A handler receives the groups its route pattern captured, in order. */
type Handler = (call: ApiCall, params: string[]) => Promise<Response>;
interface Route { pattern: RegExp; methods: ReadonlyMap<string, Handler> }
const defineRoute = (pattern: RegExp, handlers: Record<string, Handler>): Route => ({ pattern, methods: new Map(Object.entries(handlers)) });

// Matched in this order. A path that matches without the request's method gets 405, and Allow lists its methods in the order written here.
const routes: readonly Route[] = [
  defineRoute(/^\/api\/entries$/, {
    POST: ({ request, memories }) => createEntry(request, memories),
    GET: ({ url, memories }) => listEntries(url, memories),
  }),
  defineRoute(/^\/api\/entries\/([^/]+)$/, {
    // The ID is parsed before the body is read, as for media.
    PATCH: ({ request, memories }, [id]) => updateEntry(request, memories, parse(memoryIdSchema, id)),
  }),
  defineRoute(/^\/api\/related$/, { GET: ({ url, memories }) => relatedPeople(url, memories) }),
  defineRoute(/^\/api\/media$/, {
    GET: ({ url, media }) => listMedia(url, media),
    POST: ({ request, media }) => uploadMedia(request, media),
  }),
  defineRoute(/^\/api\/media\/([^/]+)$/, {
    // The ID is parsed before the body is read, so a malformed ID is reported ahead of a malformed body.
    PATCH: ({ request, media }, [id]) => updateMedia(request, media, parse(mediaIdSchema, id)),
    DELETE: ({ request, media }, [id]) => deleteMedia(request, media, parse(mediaIdSchema, id)),
  }),
  defineRoute(variantPath, {
    GET: ({ media }, [id, variant]) => readMedia(media, parse(mediaIdSchema, id), parse(mediaVariantSchema, variant)),
  }),
];

/** The first route whose pattern matches the path, with the groups it captured. */
function findRoute(pathname: string): { route: Route; params: string[] } | undefined {
  for (const candidate of routes) {
    const match = candidate.pattern.exec(pathname);
    if (match) return { route: candidate, params: match.slice(1) };
  }
  return undefined;
}

async function handleRoute(call: ApiCall): Promise<Response> {
  const found = findRoute(call.url.pathname);
  if (!found) return fail(404, 'not_found', 'Not found');
  const handler = found.route.methods.get(call.request.method);
  if (!handler) return notAllowed([...found.route.methods.keys()].join(', '));
  return handler(call, found.params);
}

/** A write must come from this origin and carry the CSRF token issued with the session. */
async function trustedWrite(request: Request, session: WebSession): Promise<boolean> {
  return sameOriginPost(request) && await checkCsrf(session, request.headers.get('X-CSRF-Token'));
}

async function dispatch(request: Request, env: ApiEnv, owner: string): Promise<Response> {
  const url = new URL(request.url);
  const session = await readSession(env.DB, request, new Date());
  if (!session || session.owner !== owner) return fail(401, 'unauthorized');
  if (request.method !== 'GET' && !await trustedWrite(request, session)) return fail(403, 'forbidden', 'Request origin or CSRF token check failed');
  return handleRoute({ request, url, memories: createCloudflareMemory(env, owner), media: createCloudflareMedia(env, owner) });
}

/** JSON and multipart API for the owner's own session. Returns null outside /api/. */
export async function handleApi(request: Request, env: ApiEnv, owner: string): Promise<Response | null> {
  if (!new URL(request.url).pathname.startsWith('/api/')) return null;
  try { return await dispatch(request, env, owner); }
  catch (error) { return errorResponse(error); }
}
