import { createMcpHandler } from 'agents/mcp/server';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { AuthorizationError, CimdFetchError, OAuthProvider, type OAuthHelpers, type OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import type { ExecutionContext } from '@cloudflare/workers-types';
import { createCloudflareMemory } from './platform/cloudflare.ts';
import { htmlEscape, PayloadTooLargeError, readBoundedForm, sameOriginPost } from './platform/http.ts';
import { verifyOwnerPassword } from './platform/owner-password.ts';
import type { R2Binding } from './platform/r2.ts';
import { handleCapture } from './platform/web-capture.ts';
import { handleApi } from './platform/web-api.ts';
import { createMemoryMcpServer, MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE } from './mcp/tools.ts';
import type { D1Binding } from './storage/d1.ts';

const OWNER_ID = 'owner';
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

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
function isSecureRequest(request: Request, _env: WorkerEnv): boolean {
  const url = new URL(request.url);
  return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
}
function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
    return page('The authorization request is invalid, has expired, or its client information could not be verified. Start connecting again from your MCP client.', 400);
  }
  return page('The authorization service is temporarily unavailable. Please try again later.', 503);
}
const defaultHandler = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    if (!isSecureRequest(request, env)) return page('Production authorization requires HTTPS.', 403);
    const capture = await handleCapture(request, env, OWNER_ID);
    if (capture) return capture;
    const api = await handleApi(request, env, OWNER_ID);
    if (api) return api;
    if (new URL(request.url).pathname !== '/authorize') return new Response('Not found', { status: 404 });
    if (request.method === 'GET') {
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
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
    if (!sameOriginPost(request)) return page('Request origin check failed. Return to your MCP client and start connecting again.', 403);
    let form: URLSearchParams;
    try { form = await readBoundedForm(request, 16_384); }
    catch (error) {
      return error instanceof PayloadTooLargeError ? page('Request too large.', 413) : page('Invalid form.', 400);
    }
    const handle = form.get('handle');
    if (typeof handle !== 'string' || !handle || handle.length > 512) return page('This authorization has expired or is invalid. Start connecting again.', 400);
    if (form.get('decision') === 'deny') {
      try {
        const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      } catch (error) {
        return error instanceof AuthorizationError ? page('This authorization has expired or is invalid. Start connecting again.', 400) : page('The authorization service is temporarily unavailable. Please try again later.', 503);
      }
    }
    if (form.get('decision') !== 'approve') return page('Invalid authorization choice.', 400);
    const requestedScopes = form.getAll('scope').filter((scope): scope is string => typeof scope === 'string');
    if (!requestedScopes.includes(MEMORY_READ_SCOPE)) return page('Connecting MeMem requires at least the read memories permission.', 400);
    const password = form.get('password');
    if (!env.OWNER_PASSWORD_HASH || !password || !await verifyOwnerPassword(password, env.OWNER_PASSWORD_HASH)) {
      return page('The owner passphrase is incorrect, or this authorization page has expired. Go back and start connecting again.', 401);
    }

    try {
      const approved = await env.OAUTH_PROVIDER.approveConsent(request, handle, { scope: requestedScopes });
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
  },
};

function makeApiHandler() {
  return {
    async fetch(request: Request, env: WorkerEnv, executionContext: ExecutionContext): Promise<Response> {
      // OAuthProvider invokes apiHandler only after validating the bearer token; its runtime
      // context adds auth/props even though its ExportedHandler declaration omits that type.
      const ctx = executionContext as (OAuthResourceContext<unknown> | undefined);
      if (!ctx || typeof ctx !== 'object' || !ctx.auth) {
        return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } });
      }
      const expectedResource = new URL(env.MCP_RESOURCE_URL).href;
      const verified = ctx.auth;
      const ownerIdFromProps = typeof ctx.props === 'object' && ctx.props !== null && 'ownerId' in ctx.props
        ? (ctx.props as { ownerId?: unknown }).ownerId
        : undefined;
      if (ownerIdFromProps !== OWNER_ID || verified.userId !== OWNER_ID || !verified.clientId || verified.audience !== expectedResource) {
        return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } });
      }
      if (!verified.scope.includes(MEMORY_READ_SCOPE)) {
        return new Response('Insufficient scope', {
          status: 403,
          headers: { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${MEMORY_READ_SCOPE}"` },
        });
      }
      const authInfo: AuthInfo = {
        token: verified.token,
        clientId: verified.clientId,
        scopes: [...verified.scope],
        ...(verified.expiresAt === undefined ? {} : { expiresAt: verified.expiresAt }),
        resource: new URL(verified.audience),
        extra: { props: ctx.props as Record<string, unknown> },
      };
      const handler = createMcpHandler(({ authInfo: requestAuth }) => {
        if (!requestAuth || requestAuth.clientId !== authInfo.clientId || requestAuth.resource?.href !== expectedResource) {
          throw new Error('Missing verified MCP auth context');
        }
        const props = requestAuth.extra?.props;
        const ownerId = typeof props === 'object' && props !== null && 'ownerId' in props
          ? (props as { ownerId?: unknown }).ownerId
          : undefined;
        if (ownerId !== OWNER_ID) throw new Error('Missing verified owner context');
        const service = createCloudflareMemory(env, OWNER_ID);
        return createMemoryMcpServer(service, {
          scopes: requestAuth.scopes,
          resourceUrl: requestAuth.resource ?? new URL(env.MCP_RESOURCE_URL),
        });
      }, { route: '/mcp', corsOptions: false });
      return handler.fetch(request, { authInfo });
    },
  };
}

function createProvider(env: WorkerEnv): OAuthProvider<WorkerEnv> {
  const resourceUrl = new URL(env.MCP_RESOURCE_URL);
  const issuerUrl = new URL(env.OAUTH_ISSUER);
  if (resourceUrl.protocol !== 'https:' && !(resourceUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(resourceUrl.hostname))) {
    throw new Error('MCP_RESOURCE_URL must be HTTPS (loopback HTTP is allowed only for local development)');
  }
  if (issuerUrl.protocol !== 'https:' && !(issuerUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(issuerUrl.hostname))) {
    throw new Error('OAUTH_ISSUER must be HTTPS (loopback HTTP is allowed only for local development)');
  }
  if (resourceUrl.pathname !== '/mcp' || resourceUrl.search || resourceUrl.hash || issuerUrl.origin !== resourceUrl.origin) {
    throw new Error('Configure one canonical origin, issuer, and /mcp resource URL');
  }
  return new OAuthProvider<WorkerEnv>({
    apiRoute: '/mcp',
    apiHandler: makeApiHandler(),
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
  });
}

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    if (!isSecureRequest(request, env)) return Promise.resolve(new Response('HTTPS is required', { status: 403 }));
    return createProvider(env).fetch(request, env, ctx);
  },
};
