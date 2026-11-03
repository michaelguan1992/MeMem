import { test, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client-current';
import schemaSql from '../migrations/d1/0001_memories.sql?raw';
import mediaSql from '../migrations/d1/0002_media.sql?raw';

const origin = 'http://localhost:8787';
const resource = `${origin}/mcp`;
const ownerPassphrase = 'test-only-owner-secret-never-used-in-production';

type JSONRecord = Record<string, unknown>;
async function json(response: Response): Promise<JSONRecord> {
  return await response.json() as JSONRecord;
}
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function randomString(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
async function s256(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}
function scope(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

interface AuthorizationAttempt {
  codeVerifier: string;
  state: string;
  handle: string;
  cookie: string;
  scopes: string[];
}
async function registerTestClient(redirectUri: string): Promise<string> {
  const response = await SELF.fetch(`${origin}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'MeMem integration security test',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'memory:read memory:write offline_access',
    }),
  });
  if (response.status !== 201) throw new Error(`Test client registration failed with HTTP ${response.status}`);
  return scope((await json(response)).client_id);
}

async function beginAuthorization(clientId: string, redirectUri: string, scopes: string[]): Promise<AuthorizationAttempt> {
  const codeVerifier = randomString(48);
  const state = randomString(24);
  const url = new URL(`${origin}/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    code_challenge: await s256(codeVerifier), code_challenge_method: 'S256', state,
    scope: scopes.join(' '), resource,
  }).toString();
  const response = await SELF.fetch(url);
  if (!response.ok) throw new Error(`Authorization request was rejected with HTTP ${response.status}`);
  const html = await response.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!handle || !cookie) throw new Error('Authorization page did not include the expected one-time browser handle');
  return { codeVerifier, state, handle, cookie, scopes };
}
async function submitApproval(attempt: AuthorizationAttempt, options: { password?: string; cookie?: string; origin?: string } = {}): Promise<Response> {
  const form = new URLSearchParams({ handle: attempt.handle, password: options.password ?? ownerPassphrase, decision: 'approve' });
  for (const value of attempt.scopes) form.append('scope', value);
  return SELF.fetch(new Request(`${origin}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: options.origin ?? origin, Cookie: options.cookie === undefined ? attempt.cookie : options.cookie },
    body: form.toString(),
  }));
}
async function submitDenial(attempt: AuthorizationAttempt): Promise<Response> {
  return SELF.fetch(new Request(`${origin}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, Cookie: attempt.cookie },
    body: new URLSearchParams({ handle: attempt.handle, decision: 'deny' }).toString(),
  }));
}

async function extractAuthorizationCode(response: Response, redirectUri: string, state: string): Promise<string> {
  if (response.status !== 302) throw new Error(`Consent did not redirect: HTTP ${response.status}`);
  const callback = new URL(response.headers.get('location') ?? '');
  if (callback.origin + callback.pathname !== redirectUri || callback.searchParams.get('state') !== state) throw new Error('OAuth callback redirect or state did not match');
  return callback.searchParams.get('code') ?? '';
}
async function exchangeCode(clientId: string, redirectUri: string, code: string, codeVerifier: string, resourceUrl = resource): Promise<Response> {
  return SELF.fetch(`${origin}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri, code_verifier: codeVerifier, resource: resourceUrl }).toString(),
  });
}

async function call<T extends JSONRecord>(client: Client, name: string, args: JSONRecord = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`MCP tool ${name} returned an error: ${JSON.stringify(result.content)}`);
  const text = result.content.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error(`MCP tool ${name} returned no text content`);
  return JSON.parse(text.slice(text.indexOf('\n') + 1)) as T;
}

test('OAuth discovery, DCR, PKCE, refresh and Streamable HTTP MCP CRUD run against Miniflare D1 + KV', async () => {
  // Production applies every migration; forget_memory also unlinks photos in the media table.
  for (const statement of `${schemaSql};${mediaSql}`.split(';').map((part) => part.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }

  const unauthenticated = await SELF.fetch(new Request(`${resource}?`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'unauthenticated-test', version: '1' } } }),
  }));
  expect(unauthenticated.status).toBe(401);
  expect(unauthenticated.headers.get('www-authenticate')).toContain('resource_metadata');
  expect(unauthenticated.headers.get('www-authenticate')).toContain('scope="memory:read memory:write"');

  const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
  const resourceMetadataResponse = await SELF.fetch(resourceMetadataUrl);
  expect(resourceMetadataResponse.status).toBe(200);
  const resourceMetadata = await json(resourceMetadataResponse);
  expect(resourceMetadata.resource).toBe(resource);
  expect(resourceMetadata.authorization_servers).toEqual([origin]);

  const asMetadataResponse = await SELF.fetch(`${origin}/.well-known/oauth-authorization-server`);
  expect(asMetadataResponse.status).toBe(200);
  const asMetadata = await json(asMetadataResponse);
  expect(asMetadata.issuer).toBe(origin);
  expect(asMetadata.code_challenge_methods_supported).toContain('S256');
  expect(asMetadata.registration_endpoint).toBe(`${origin}/oauth/register`);
  expect(asMetadata.token_endpoint).toBe(`${origin}/oauth/token`);

  const redirectUri = 'http://127.0.0.1:43210/oauth/callback';
  const registrationResponse = await SELF.fetch(`${origin}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'MeMem integration MCP client',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'memory:read memory:write offline_access',
    }),
  });
  expect(registrationResponse.status).toBe(201);
  const registration = await json(registrationResponse);
  const clientId = scope(registration.client_id);
  expect(clientId).not.toBe('');
  expect(registration.client_secret).toBeUndefined();

  const codeVerifier = randomString(48);
  const state = randomString(24);
  const authorizeUrl = new URL(`${origin}/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: await s256(codeVerifier),
    code_challenge_method: 'S256',
    state,
    scope: 'memory:read memory:write offline_access',
    resource,
  }).toString();
  const authorizeResponse = await SELF.fetch(authorizeUrl);
  expect(authorizeResponse.status).toBe(200);
  expect(authorizeResponse.headers.get('referrer-policy')).toBe('same-origin');
  expect(authorizeResponse.headers.get('content-security-policy')).toBe(
    "default-src 'none'; form-action 'self' http://127.0.0.1:43210; base-uri 'none'; frame-ancestors 'none'",
  );
  const html = await authorizeResponse.text();
  expect(html).toContain('MeMem integration MCP client');
  expect(html).toContain('Read memories');
  expect(html).toContain('Save, edit, and delete memories');
  expect(html).toContain('Stay connected');
  expect(html).toContain('formnovalidate');
  const handleMatch = html.match(/name="handle" value="([^"]+)"/);
  expect(handleMatch).not.toBeNull();
  const handle = handleMatch?.[1] ?? '';
  const cookie = authorizeResponse.headers.get('set-cookie')?.split(';', 1)[0];
  expect(cookie).toMatch(/^__Host-oauth-consent-[a-f0-9]+=/);

  const consent = await SELF.fetch(new Request(`${origin}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: origin,
      Cookie: cookie ?? '',
    },
    body: new URLSearchParams({
      handle,
      password: ownerPassphrase,
      decision: 'approve',
      scope: 'memory:read',
    }).toString() + '&scope=memory%3Awrite&scope=offline_access',
  }));
  expect(consent.status).toBe(302);
  const callback = new URL(consent.headers.get('location') ?? '');
  expect(callback.origin + callback.pathname).toBe(redirectUri);
  expect(callback.searchParams.get('state')).toBe(state);
  expect(callback.searchParams.get('iss')).toBe(origin);
  const authorizationCode = callback.searchParams.get('code');
  expect(authorizationCode).toBeTruthy();

  const tokenResponse = await SELF.fetch(`${origin}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode ?? '',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      resource,
    }).toString(),
  });
  expect(tokenResponse.status).toBe(200);
  const tokenSet = await json(tokenResponse);
  const accessToken = scope(tokenSet.access_token);
  const refreshToken = scope(tokenSet.refresh_token);
  expect(accessToken.length).toBeGreaterThan(20);
  expect(refreshToken.length).toBeGreaterThan(20);
  expect(scope(tokenSet.scope).split(' ')).toEqual(expect.arrayContaining(['memory:read', 'memory:write', 'offline_access']));

  const refreshedResponse = await SELF.fetch(`${origin}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      resource,
    }).toString(),
  });
  expect(refreshedResponse.status).toBe(200);
  const refreshedToken = scope((await json(refreshedResponse)).access_token);
  expect(refreshedToken.length).toBeGreaterThan(20);

  const denialClient = await registerTestClient(redirectUri);
  const denialAttempt = await beginAuthorization(denialClient, redirectUri, ['memory:read']);
  const denialResponse = await submitDenial(denialAttempt);
  expect(denialResponse.status).toBe(302);
  const deniedCallback = new URL(denialResponse.headers.get('location') ?? '');
  expect(deniedCallback.searchParams.get('error')).toBe('access_denied');
  expect(deniedCallback.searchParams.get('state')).toBe(denialAttempt.state);
  expect(deniedCallback.searchParams.get('iss')).toBe(origin);

  const wrongResourceClient = await registerTestClient(redirectUri);
  const wrongResourceAttempt = await beginAuthorization(wrongResourceClient, redirectUri, ['memory:read', 'memory:write', 'offline_access']);
  const wrongResourceCode = await extractAuthorizationCode(await submitApproval(wrongResourceAttempt), redirectUri, wrongResourceAttempt.state);
  const wrongResourceResponse = await exchangeCode(wrongResourceClient, redirectUri, wrongResourceCode, wrongResourceAttempt.codeVerifier, `${origin}/wrong-resource`);
  expect(wrongResourceResponse.status).toBe(400);
  expect((await json(wrongResourceResponse)).error).toBe('invalid_target');

  const wrongVerifierClient = await registerTestClient(redirectUri);
  const wrongVerifierAttempt = await beginAuthorization(wrongVerifierClient, redirectUri, ['memory:read', 'memory:write', 'offline_access']);
  const wrongVerifierCode = await extractAuthorizationCode(await submitApproval(wrongVerifierAttempt), redirectUri, wrongVerifierAttempt.state);
  const wrongVerifierResponse = await exchangeCode(wrongVerifierClient, redirectUri, wrongVerifierCode, randomString(48));
  expect(wrongVerifierResponse.status).toBe(400);
  expect((await json(wrongVerifierResponse)).error).toBe('invalid_grant');

  const browserBindingClient = await registerTestClient(redirectUri);
  const browserBindingAttempt = await beginAuthorization(browserBindingClient, redirectUri, ['memory:read', 'offline_access']);
  const nullOrigin = await submitApproval(browserBindingAttempt, { origin: 'null', cookie: browserBindingAttempt.cookie });
  expect(nullOrigin.status).toBe(403);
  expect(nullOrigin.headers.get('location')).toBeNull();
  const crossOrigin = await submitApproval(browserBindingAttempt, { origin: 'https://attacker.example', cookie: browserBindingAttempt.cookie });
  expect(crossOrigin.status).toBe(403);
  expect(crossOrigin.headers.get('location')).toBeNull();
  const noCookie = await submitApproval(browserBindingAttempt, { origin, cookie: '' });
  expect(noCookie.status).toBe(400);
  expect(noCookie.headers.get('location')).toBeNull();

  const wrongPasswordClient = await registerTestClient(redirectUri);
  const wrongPasswordAttempt = await beginAuthorization(wrongPasswordClient, redirectUri, ['memory:read', 'offline_access']);
  const wrongPassword = await submitApproval(wrongPasswordAttempt, { password: 'incorrect-test-password' });
  expect(wrongPassword.status).toBe(401);
  expect(wrongPassword.headers.get('location')).toBeNull();
  expect(wrongPassword.headers.get('content-security-policy')).toBe("default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  expect(await wrongPassword.text()).not.toContain('code=');

  const readOnlyClient = await registerTestClient(redirectUri);
  const readOnlyAttempt = await beginAuthorization(readOnlyClient, redirectUri, ['memory:read', 'offline_access']);
  const readOnlyCode = await extractAuthorizationCode(await submitApproval(readOnlyAttempt), redirectUri, readOnlyAttempt.state);
  const readOnlyTokenResponse = await exchangeCode(readOnlyClient, redirectUri, readOnlyCode, readOnlyAttempt.codeVerifier);
  expect(readOnlyTokenResponse.status).toBe(200);
  const readOnlyTokenSet = await json(readOnlyTokenResponse);
  const readOnlyToken = scope(readOnlyTokenSet.access_token);
  expect(readOnlyToken.length).toBeGreaterThan(20);
  expect(scope(readOnlyTokenSet.scope).split(' ')).toEqual(expect.arrayContaining(['memory:read']));
  expect(scope(readOnlyTokenSet.scope).split(' ')).not.toContain('memory:write');

  let rawToolsListResponse = '';
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    authProvider: { token: async () => refreshedToken },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      request.headers.set('Host', new URL(request.url).host);
      const requestBody = await request.clone().text();
      const response = await SELF.fetch(request);
      if (requestBody.includes('\"method\":\"tools/list\"')) rawToolsListResponse = await response.clone().text();
      if (new URL(request.url).pathname === '/mcp' && response.status >= 500) {
        // Keep test diagnostics free of request headers, tokens, and memory content.
      }
      return response;
    },
  });
  const client = new Client({ name: 'memem-integration-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = listed.tools as unknown as Array<JSONRecord>;
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'record_memory', 'search_memories', 'get_memory', 'correct_memory', 'forget_memory',
    ]));
    const rawPayload = rawToolsListResponse.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim() ?? rawToolsListResponse;
    const wireMessage = JSON.parse(rawPayload) as { result?: { tools?: JSONRecord[] } };
    const wireWriteTool = wireMessage.result?.tools?.find((tool) => tool.name === 'correct_memory');
    expect(wireWriteTool?.securitySchemes).toEqual([{ type: 'oauth2', scopes: ['memory:read', 'memory:write'] }]);
    const writeTool = tools.find((tool) => tool.name === 'correct_memory');
    expect((tools.find((tool) => tool.name === 'record_memory')?.annotations as JSONRecord).idempotentHint).toBe(false);
    expect((writeTool?.annotations as JSONRecord).destructiveHint).toBe(true);

    const person = await call<JSONRecord>(client, 'record_memory', { kind: 'person', text: 'Matthew' });
    expect(person.text).toBe('Matthew');
    expect(person.originalText).toBeUndefined();
    const personId = scope(person.id);

    const meal = await call<JSONRecord>(client, 'record_memory', {
      kind: 'event',
      text: 'Matthew在中餐馆吃午餐。',
      occurredAt: '2026-10-08T12:30:00-07:00',
      relatedIds: [personId],
    });
    expect(meal.occurredAt).toBe('2026-10-08T19:30:00.000Z');

    const relationship = await call<JSONRecord>(client, 'record_memory', {
      kind: 'fact',
      text: 'Matthew的妻子是Linda。',
      relatedIds: [personId],
    });
    expect(relationship.relatedIds).toEqual([personId]);

    const byMatthew = await call<{ memories: JSONRecord[] }>(client, 'search_memories', { text: 'Matthew' });
    expect(byMatthew.memories.map((memory) => memory.text)).toEqual(expect.arrayContaining(['Matthew', 'Matthew在中餐馆吃午餐。', 'Matthew的妻子是Linda。']));
    const byLinda = await call<{ memories: JSONRecord[] }>(client, 'search_memories', { text: 'Linda' });
    expect(byLinda.memories[0]?.relatedIds).toEqual([personId]);
    const byDate = await call<{ memories: JSONRecord[] }>(client, 'search_memories', {
      from: '2026-10-08T19:00:00Z', before: '2026-10-08T20:00:00Z',
    });
    expect(byDate.memories.map((memory) => memory.text)).toEqual(['Matthew在中餐馆吃午餐。']);

    const corrected = await call<JSONRecord>(client, 'correct_memory', {
      id: personId, expectedVersion: 1, kind: 'person', text: 'Matthew（当前记录）',
    });
    expect(corrected.version).toBe(2);
    expect(corrected.originalText).toBeUndefined();
    const conflict = await client.callTool({ name: 'correct_memory', arguments: {
      id: personId, expectedVersion: 1, kind: 'person', text: '错误的旧版本覆盖',
    } });
    expect(conflict.isError).toBe(true);
    const current = await call<JSONRecord>(client, 'get_memory', { id: personId });
    expect(current.text).toBe('Matthew（当前记录）');

    const secondTransport = new StreamableHTTPClientTransport(new URL(resource), {
      authProvider: { token: async () => readOnlyToken },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        request.headers.set('Host', new URL(request.url).host);
        return SELF.fetch(request);
      },
    });
    const secondClient = new Client({ name: 'memem-second-connection', version: '1.0.0' });
    try {
      await secondClient.connect(secondTransport);
      const relationLookup = await call<{ memories: JSONRecord[] }>(secondClient, 'search_memories', { text: 'Linda' });
      expect(relationLookup.memories[0]?.text).toBe('Matthew的妻子是Linda。');
      expect(relationLookup.memories[0]?.relatedIds).toEqual([personId]);
      const deniedWrite = await secondClient.callTool({ name: 'record_memory', arguments: { kind: 'fact', text: 'must not be stored' } });
      expect(deniedWrite.isError).toBe(true);
      expect(JSON.stringify(deniedWrite)).toContain('memory:write');
      const noMutation = await call<{ memories: JSONRecord[] }>(secondClient, 'search_memories', { text: 'must not be stored' });
      expect(noMutation.memories).toEqual([]);
    } finally {
      await secondClient.close();
    }

    const deleted = await call<JSONRecord>(client, 'forget_memory', { id: scope(relationship.id), expectedVersion: 1 });
    expect(deleted.deleted).toBe(true);
    const gone = await client.callTool({ name: 'get_memory', arguments: { id: relationship.id } });
    expect(gone.isError).toBe(true);
  } finally {
    await client.close();
  }
});

test('a stale consent denial gets the expired-authorization page and no redirect', async () => {
  const response = await SELF.fetch(new Request(`${origin}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
    body: new URLSearchParams({ handle: 'never-issued-handle', decision: 'deny' }).toString(),
  }));
  expect(response.status).toBe(400);
  expect(response.headers.get('location')).toBeNull();
  expect(await response.text()).toContain('This authorization has expired or is invalid.');
});
