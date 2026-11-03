import { createMcpHandler } from 'agents/mcp/server';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { AuthorizationError, CimdFetchError, OAuthProvider, type OAuthHelpers, type OAuthProviderOptions, type OAuthResourceAuth, type OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import type { ExecutionContext } from '@cloudflare/workers-types';
import { createCloudflareMemory } from './platform/cloudflare.ts';
import { htmlEscape, readFormOrRefusal, sameOriginPost } from './platform/http.ts';
import { verifyOwnerPassword } from './platform/owner-password.ts';
import type { R2Binding } from './platform/r2.ts';
import { handleCapture } from './platform/web-capture.ts';
import { handleApi } from './platform/web-api.ts';
import { createMemoryMcpServer, MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE } from './mcp/tools.ts';
import type { D1Binding } from './storage/d1.ts';

const OWNER_ID = 'owner';
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

interface WorkerEnv {
  DB: D1Binding;
  MEDIA: R2Binding;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  OWNER_PASSWORD_HASH: string;
  MCP_RESOURCE_URL: string;
  OAUTH_ISSUER: string;
  APP_ENV?: string;
}

const pageHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};
function page(message: string, status = 400): Response {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>MeMem authorization</title><h1>MeMem authorization</h1><p>${htmlEscape(message)}</p>`, { status, headers: pageHeaders });
}
function consentCallbackOrigin(redirectUri: string): string {
  // OAuthProvider only returns this URI after matching it to a registered client redirect.
  // Reduce it to a normalized web origin before putting it in a response header.
  const callback = new URL(redirectUri);
  const loopbackHost = callback.hostname === 'localhost'
    || callback.hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/.test(callback.hostname);
  if (callback.username || callback.password || callback.origin === 'null'
    || (callback.protocol !== 'https:' && !(callback.protocol === 'http:' && loopbackHost))) {
    throw new Error('OAuthProvider returned an unsupported callback URI');
  }
  return callback.origin;
}

function consentPage(details: Awaited<ReturnType<OAuthHelpers['describeConsent']>>, handle: string, errorMessage = ''): string {
  const scopeLabel = (scope: string): string => scope === MEMORY_READ_SCOPE ? 'Read memories' : scope === MEMORY_WRITE_SCOPE ? 'Save, edit, and delete memories' : scope === 'offline_access' ? 'Stay connected (allow secure token refresh)' : scope;
  const scopes = details.scope.map((scope) => `<label><input type="checkbox" name="scope" value="${htmlEscape(scope)}" checked> ${htmlEscape(scopeLabel(scope))}</label>`).join('<br>');
  const redirectNotice = details.redirectIsLoopback
    ? '<p><strong>Authorization will be sent to an app on this device. Continue only if you just started connecting from that app.</strong></p>'
    : '';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Connect MeMem</title><h1>Connect MeMem</h1><p><strong>${htmlEscape(details.clientName)}</strong> is requesting access to your personal memories.</p><p>Authorization will be sent to: <strong>${htmlEscape(details.redirectHost)}</strong></p>${details.clientDomain ? `<p>Client website: <strong>${htmlEscape(details.clientDomain)}</strong></p>` : '<p>The client name is self-reported and its publisher has not been verified.</p>'}${redirectNotice}<p>Choose the permissions to allow:</p><form method="post" action="/authorize"><input type="hidden" name="handle" value="${htmlEscape(handle)}">${scopes}<p><label>Owner passphrase: <input type="password" name="password" autocomplete="current-password" required></label></p>${errorMessage ? `<p role="alert">${htmlEscape(errorMessage)}</p>` : ''}<p><button name="decision" value="approve">Allow and connect</button> <button name="decision" value="deny" formnovalidate>Deny</button></p></form></html>`;
}
/** HTTPS, or plain HTTP to this machine for local development. */
function isSecureUrl(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname));
}
function isSecureRequest(request: Request, _env: WorkerEnv): boolean {
  return isSecureUrl(new URL(request.url));
}
function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
    return page('The authorization request is invalid, has expired, or its client information could not be verified. Start connecting again from your MCP client.', 400);
  }
  return page('The authorization service is temporarily unavailable. Please try again later.', 503);
}
/** Everything that is not OAuthProvider's own route: the capture pages, the owner's JSON API, and the consent page. */
async function serveWeb(request: Request, env: WorkerEnv): Promise<Response> {
  if (!isSecureRequest(request, env)) return page('Production authorization requires HTTPS.', 403);
  const surface = await serveSurface(request, env);
  if (surface) return surface;
  if (new URL(request.url).pathname !== '/authorize') return new Response('Not found', { status: 404 });
  return authorize(request, env);
}
const defaultHandler = { fetch: serveWeb };

/** The capture pages and the JSON API. Null for any other path. */
async function serveSurface(request: Request, env: WorkerEnv): Promise<Response | null> {
  const capture = await handleCapture(request, env, OWNER_ID);
  if (capture) return capture;
  return handleApi(request, env, OWNER_ID);
}

/** /authorize: the consent page for GET, and the approve or deny decision for POST. */
async function authorize(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method === 'GET') return showConsent(request, env);
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
  return submitConsent(request, env);
}

async function showConsent(request: Request, env: WorkerEnv): Promise<Response> {
  try {
    const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    const details = await env.OAUTH_PROVIDER.describeConsent(authRequest);
    const consent = await env.OAUTH_PROVIDER.beginConsent(authRequest);
    consent.headers.set('Content-Type', 'text/html; charset=utf-8');
    consent.headers.set('Cache-Control', 'no-store');
    consent.headers.set('Referrer-Policy', 'same-origin');
    consent.headers.set('X-Content-Type-Options', 'nosniff');
    consent.headers.set('X-Frame-Options', 'DENY');
    // Chrome checks form-action through the approval POST's 302. Permit only the origin
    // from OAuthProvider's already-validated redirect URI, retaining a narrow source list.
    consent.headers.set('Content-Security-Policy', `default-src 'none'; form-action 'self' ${consentCallbackOrigin(authRequest.redirectUri)}; base-uri 'none'; frame-ancestors 'none'`);
    return new Response(consentPage(details, consent.handle), { headers: consent.headers });
  } catch (error) {
    return authErrorResponse(error);
  }
}

/** A consent form that passed the origin check and carries a well-formed one-time handle. */
interface Submission { form: URLSearchParams; handle: string }

async function submitConsent(request: Request, env: WorkerEnv): Promise<Response> {
  const submission = await readSubmission(request);
  if (submission instanceof Response) return submission;
  const { form, handle } = submission;
  if (form.get('decision') === 'deny') return denyAuthorization(request, env, handle);
  if (form.get('decision') !== 'approve') return page('Invalid authorization choice.', 400);
  return approveAuthorization(request, env, form, handle);
}

/** Checks the origin, reads the form, and checks the handle. Returns the page to send instead when any of these fails. */
async function readSubmission(request: Request): Promise<Submission | Response> {
  if (!sameOriginPost(request)) return page('Request origin check failed. Return to your MCP client and start connecting again.', 403);
  const form = await readFormOrRefusal(request, 16_384);
  if (!(form instanceof URLSearchParams)) return page(form.message, form.status);
  const handle = validHandle(form);
  if (!handle) return page('This authorization has expired or is invalid. Start connecting again.', 400);
  return { form, handle };
}

/** A handle is a non-empty string of at most 512 characters. Anything else is no handle. */
function validHandle(form: URLSearchParams): string | undefined {
  const handle = form.get('handle');
  return typeof handle === 'string' && handle && handle.length <= 512 ? handle : undefined;
}

async function denyAuthorization(request: Request, env: WorkerEnv, handle: string): Promise<Response> {
  try {
    const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  } catch (error) {
    return error instanceof AuthorizationError
      ? page('This authorization has expired or is invalid. Start connecting again.', 400)
      : page('The authorization service is temporarily unavailable. Please try again later.', 503);
  }
}

/** Approval needs the read permission and the owner passphrase, both checked before anything is granted. */
async function approveAuthorization(request: Request, env: WorkerEnv, form: URLSearchParams, handle: string): Promise<Response> {
  const requestedScopes = form.getAll('scope').filter((scope): scope is string => typeof scope === 'string');
  if (!requestedScopes.includes(MEMORY_READ_SCOPE)) return page('Connecting MeMem requires at least the read memories permission.', 400);
  const password = form.get('password');
  if (!env.OWNER_PASSWORD_HASH || !password || !await verifyOwnerPassword(password, env.OWNER_PASSWORD_HASH)) {
    return page('The owner passphrase is incorrect, or this authorization page has expired. Go back and start connecting again.', 401);
  }
  return completeApproval(request, env, handle, requestedScopes);
}

async function completeApproval(request: Request, env: WorkerEnv, handle: string, scope: string[]): Promise<Response> {
  try {
    const approved = await env.OAUTH_PROVIDER.approveConsent(request, handle, { scope });
    const authorization = await env.OAUTH_PROVIDER.completeAuthorization({
      request: approved.request,
      userId: OWNER_ID,
      metadata: {},
      scope: approved.request.scope,
      props: { ownerId: OWNER_ID },
    });
    approved.headers.set('Location', authorization.redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    return error instanceof AuthorizationError || error instanceof CimdFetchError
      ? page('This authorization has expired or the selected permissions are invalid. Start connecting again.', 400)
      : page('The authorization service is temporarily unavailable. Please try again later.', 503);
  }
}

/** OAuthProvider attaches `auth` to the execution context only after it has validated the bearer token. */
function resourceContext(executionContext: ExecutionContext): OAuthResourceContext<unknown> | undefined {
  // Its runtime context adds auth/props even though its ExportedHandler declaration omits that type.
  const ctx = executionContext as (OAuthResourceContext<unknown> | undefined);
  return ctx && typeof ctx === 'object' && ctx.auth ? ctx : undefined;
}

/** The owner recorded in a token's props. Anything other than an object carrying `ownerId` is no owner. */
function ownerOf(props: unknown): unknown {
  return typeof props === 'object' && props !== null && 'ownerId' in props ? (props as { ownerId?: unknown }).ownerId : undefined;
}

/** A token belongs to this owner only if it was issued to the owner, to a client, for this resource. */
function isOwnersToken(verified: OAuthResourceAuth, props: unknown, expectedResource: string): verified is OAuthResourceAuth & { clientId: string } {
  return ownerOf(props) === OWNER_ID && verified.userId === OWNER_ID && Boolean(verified.clientId) && verified.audience === expectedResource;
}

function authInfoOf(verified: OAuthResourceAuth & { clientId: string }, props: unknown): AuthInfo {
  return {
    token: verified.token,
    clientId: verified.clientId,
    scopes: [...verified.scope],
    ...(verified.expiresAt === undefined ? {} : { expiresAt: verified.expiresAt }),
    resource: new URL(verified.audience),
    extra: { props: props as Record<string, unknown> },
  };
}

function unauthorizedResponse(): Response {
  return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } });
}

function insufficientScopeResponse(): Response {
  return new Response('Insufficient scope', {
    status: 403,
    headers: { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${MEMORY_READ_SCOPE}"` },
  });
}

/** The MCP server for one request. Its owner comes only from the verified props, and its memory service is built for that owner. */
function mcpServerFor(env: WorkerEnv, requestAuth: AuthInfo) {
  if (ownerOf(requestAuth.extra?.props) !== OWNER_ID) throw new Error('Missing verified owner context');
  const service = createCloudflareMemory(env, OWNER_ID);
  return createMemoryMcpServer(service, {
    scopes: requestAuth.scopes,
    resourceUrl: requestAuth.resource ?? new URL(env.MCP_RESOURCE_URL),
  });
}

/** The transport passes back the auth it was given. Anything other than this request's verified auth is refused. */
function assertSameAuth(requestAuth: AuthInfo | undefined, authInfo: AuthInfo, expectedResource: string): asserts requestAuth is AuthInfo {
  if (!requestAuth || requestAuth.clientId !== authInfo.clientId || requestAuth.resource?.href !== expectedResource) {
    throw new Error('Missing verified MCP auth context');
  }
}

function mcpHandlerFor(env: WorkerEnv, authInfo: AuthInfo, expectedResource: string) {
  // corsOptions: false adds no CORS headers. OAuthProvider reflects an accepted Origin (bearer-only /mcp, no cookies); others get 403.
  return createMcpHandler(({ authInfo: requestAuth }) => {
    assertSameAuth(requestAuth, authInfo, expectedResource);
    return mcpServerFor(env, requestAuth);
  }, { route: '/mcp', corsOptions: false });
}

/** The protected MCP resource. OAuthProvider calls it only after the bearer token has been validated. */
async function serveMcp(request: Request, env: WorkerEnv, executionContext: ExecutionContext): Promise<Response> {
  const ctx = resourceContext(executionContext);
  if (!ctx) return unauthorizedResponse();
  const expectedResource = new URL(env.MCP_RESOURCE_URL).href;
  const verified = ctx.auth;
  if (!isOwnersToken(verified, ctx.props, expectedResource)) return unauthorizedResponse();
  if (!verified.scope.includes(MEMORY_READ_SCOPE)) return insufficientScopeResponse();
  const authInfo = authInfoOf(verified, ctx.props);
  return mcpHandlerFor(env, authInfo, expectedResource).fetch(request, { authInfo });
}

function createProvider(env: WorkerEnv): OAuthProvider<WorkerEnv> {
  const resourceUrl = new URL(env.MCP_RESOURCE_URL);
  const issuerUrl = new URL(env.OAUTH_ISSUER);
  if (!isSecureUrl(resourceUrl)) throw new Error('MCP_RESOURCE_URL must be HTTPS (loopback HTTP is allowed only for local development)');
  if (!isSecureUrl(issuerUrl)) throw new Error('OAUTH_ISSUER must be HTTPS (loopback HTTP is allowed only for local development)');
  assertCanonical(resourceUrl, issuerUrl);
  return new OAuthProvider<WorkerEnv>(providerOptions(resourceUrl, issuerUrl));
}

/** One origin serves both the issuer and the /mcp resource, and the resource carries no query or fragment. */
function assertCanonical(resourceUrl: URL, issuerUrl: URL): void {
  if (resourceUrl.pathname !== '/mcp' || resourceUrl.search || resourceUrl.hash || issuerUrl.origin !== resourceUrl.origin) {
    throw new Error('Configure one canonical origin, issuer, and /mcp resource URL');
  }
}

/** The OAuthProvider configuration: endpoints, token lifetimes, scopes, and the protected-resource metadata this deployment advertises. */
function providerOptions(resourceUrl: URL, issuerUrl: URL): OAuthProviderOptions<WorkerEnv> {
  return {
    apiRoute: '/mcp',
    apiHandler: { fetch: serveMcp },
    defaultHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    accessTokenTTL: 60 * 60,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
    scopesSupported: [MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE, 'offline_access'],
    // Clients such as Claude request exactly these first; consent can still drop write.
    requiredScopes: [MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE],
    resourceMetadata: {
      resource: resourceUrl.href,
      authorization_servers: [issuerUrl.origin],
      resource_name: 'MeMem personal memory service',
      bearer_methods_supported: ['header'],
    },
  };
}

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    if (!isSecureRequest(request, env)) return Promise.resolve(new Response('HTTPS is required', { status: 403 }));
    return createProvider(env).fetch(request, env, ctx);
  },
};
