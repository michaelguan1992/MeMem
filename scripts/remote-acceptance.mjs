#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client-current';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://memem.michaelguan1992.workers.dev';
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT_URI = 'http://127.0.0.1:43210/oauth/callback';
const SCOPES = ['memory:read', 'memory:write'];
const TIMEOUT_MS = 25_000;
const FAILURE_STAGES = ['discovery', 'register', 'authorize', 'token', 'connect', 'create', 'search', 'correct', 'reconnect', 'delete', 'cleanup'];
let currentStage = 'discovery';
let failedHttp = null;

function setStage(stage) {
  if (!FAILURE_STAGES.includes(stage)) throw new Error('invalid stage');
  currentStage = stage;
}
function requireStatus(response, expected) {
  if (response.status !== expected) {
    if (failedHttp === null) failedHttp = { stage: currentStage, status: response.status };
    throw new Error('HTTP status mismatch');
  }
}
function requireCondition(condition) {
  if (!condition) throw new Error('acceptance check failed');
}

function readOwnerPassphrase() {
  const directory = resolve(ROOT, '.secrets');
  const path = resolve(directory, 'owner-passphrase');
  const directoryStat = lstatSync(directory);
  const fileStat = lstatSync(path);
  requireCondition(directoryStat.isDirectory() && !directoryStat.isSymbolicLink() && (directoryStat.mode & 0o777) === 0o700);
  requireCondition(fileStat.isFile() && !fileStat.isSymbolicLink() && (fileStat.mode & 0o777) === 0o600);
  const passphrase = readFileSync(path, 'utf8').trim();
  requireCondition(passphrase.length > 0 && passphrase.length <= 512);
  return passphrase;
}

function randomBase64Url(byteLength) {
  return randomBytes(byteLength).toString('base64url');
}
function s256(value) {
  return createHash('sha256').update(value).digest('base64url');
}
function timedFetch(input, init = {}) {
  return fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}
async function trackedMcpFetch(input, init = {}) {
  const response = await timedFetch(input, init);
  if (response.status >= 400 && response.status !== 405 && failedHttp === null) failedHttp = { stage: currentStage, status: response.status };
  return response;
}
async function jsonResponse(response) {
  requireStatus(response, 200);
  return response.json();
}

async function registerClient() {
  const response = await timedFetch(`${ORIGIN}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'MeMem deployment acceptance',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPES.join(' '),
    }),
  });
  requireStatus(response, 201);
  const registration = await response.json();
  requireCondition(typeof registration.client_id === 'string' && registration.client_id.length > 0);
  requireCondition(registration.client_secret === undefined);
  return registration.client_id;
}

async function authorizeAndGetToken(clientId, passphrase) {
  const codeVerifier = randomBase64Url(48);
  const state = randomBase64Url(24);
  const authorizeUrl = new URL(`${ORIGIN}/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: s256(codeVerifier),
    code_challenge_method: 'S256',
    state,
    scope: SCOPES.join(' '),
    resource: RESOURCE,
  }).toString();

  setStage('authorize');
  const consentPage = await timedFetch(authorizeUrl);
  requireStatus(consentPage, 200);
  const html = await consentPage.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  const cookie = consentPage.headers.get('set-cookie')?.split(';', 1)[0];
  requireCondition(Boolean(handle && cookie));

  const form = new URLSearchParams({ handle, password: passphrase, decision: 'approve' });
  for (const scope of SCOPES) form.append('scope', scope);
  const approval = await timedFetch(`${ORIGIN}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: ORIGIN,
      Cookie: cookie,
    },
    body: form.toString(),
  });
  requireStatus(approval, 302);
  const callback = new URL(approval.headers.get('location') ?? '');
  requireCondition(callback.origin + callback.pathname === REDIRECT_URI);
  requireCondition(callback.searchParams.get('state') === state);
  requireCondition(callback.searchParams.get('iss') === ORIGIN);
  const code = callback.searchParams.get('code');
  requireCondition(Boolean(code));

  setStage('token');
  const tokenResponse = await timedFetch(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
      resource: RESOURCE,
    }).toString(),
  });
  requireStatus(tokenResponse, 200);
  const tokenSet = await tokenResponse.json();
  requireCondition(typeof tokenSet.access_token === 'string' && tokenSet.access_token.length > 20);
  requireCondition((tokenSet.scope ?? '').split(' ').includes('memory:read'));
  requireCondition((tokenSet.scope ?? '').split(' ').includes('memory:write'));
  return tokenSet.access_token;
}

async function connectMcpClient(name, accessToken) {
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    authProvider: { token: async () => accessToken },
    fetch: trackedMcpFetch,
  });
  await client.connect(transport);
  return client;
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  requireCondition(!result.isError);
  const text = result.content.find((item) => item.type === 'text')?.text;
  requireCondition(typeof text === 'string');
  const newline = text.indexOf('\n');
  return JSON.parse(newline >= 0 ? text.slice(newline + 1) : text);
}

async function verifyDiscovery() {
  const resourceResponse = await timedFetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
  const resourceMetadata = await jsonResponse(resourceResponse);
  requireCondition(resourceMetadata.resource === RESOURCE);
  requireCondition(Array.isArray(resourceMetadata.authorization_servers) && resourceMetadata.authorization_servers.includes(ORIGIN));

  const authorizationResponse = await timedFetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
  const authorizationMetadata = await jsonResponse(authorizationResponse);
  requireCondition(authorizationMetadata.issuer === ORIGIN);
  requireCondition(authorizationMetadata.registration_endpoint === `${ORIGIN}/oauth/register`);
  requireCondition(authorizationMetadata.token_endpoint === `${ORIGIN}/oauth/token`);
  requireCondition(authorizationMetadata.code_challenge_methods_supported?.includes('S256'));
}

let primaryClient;
let reconnectClient;
let recordId;
let recordMayExist = false;
let marker;
let initialText;
let correctedText;
let acceptanceOk = false;
let cleanupOk = true;

async function cleanupRecord() {
  if (!recordMayExist) return true;
  if (!primaryClient || !marker) return false;
  try {
    let candidates = [];
    if (recordId) {
      try {
        const current = await callTool(primaryClient, 'get_memory', { id: recordId });
        if (current.id === recordId && typeof current.text === 'string' && current.text.startsWith(marker) && current.kind === 'fact') {
          candidates = [current];
        }
      } catch { /* Search by the unique marker below if the direct read is unavailable. */ }
    }
    if (candidates.length === 0) {
      const search = await callTool(primaryClient, 'search_memories', { text: marker, limit: 10 });
      candidates = Array.isArray(search.memories) ? search.memories : [];
    }
    for (const memory of candidates) {
      if (typeof memory.id !== 'string' || typeof memory.text !== 'string' || !memory.text.startsWith(marker) || memory.kind !== 'fact') continue;
      if (!Number.isSafeInteger(memory.version) || memory.version < 1) return false;
      setStage('delete');
    const deletion = await callTool(primaryClient, 'forget_memory', { id: memory.id, expectedVersion: memory.version });
      if (deletion.deleted !== true || deletion.id !== memory.id) return false;
    }
    const remaining = await callTool(primaryClient, 'search_memories', { text: marker, limit: 10 });
    return Array.isArray(remaining.memories) && remaining.memories.length === 0;
  } catch {
    return false;
  }
}

async function main() {
  let acceptanceFailureStage;
  try {
    const passphrase = readOwnerPassphrase();
    setStage('discovery');
    await verifyDiscovery();
    setStage('register');
    const clientId = await registerClient();
    setStage('authorize');
    const accessToken = await authorizeAndGetToken(clientId, passphrase);
    setStage('connect');
    primaryClient = await connectMcpClient('memem-deployment-acceptance', accessToken);

    marker = `MeMem deployment acceptance ${randomBytes(16).toString('hex')}`;
    initialText = `${marker} created`;
    correctedText = `${marker} corrected`;
    setStage('create');
    recordMayExist = true;
    const created = await callTool(primaryClient, 'record_memory', { kind: 'fact', text: initialText });
    requireCondition(typeof created.id === 'string' && created.version === 1 && created.text === initialText);
    recordId = created.id;

    setStage('search');
    const found = await callTool(primaryClient, 'search_memories', { text: marker, limit: 10 });
    requireCondition(Array.isArray(found.memories) && found.memories.length === 1);
    requireCondition(found.memories[0].id === recordId && found.memories[0].text === initialText);

    setStage('correct');
    const corrected = await callTool(primaryClient, 'correct_memory', {
      id: recordId,
      expectedVersion: created.version,
      kind: 'fact',
      text: correctedText,
    });
    requireCondition(corrected.id === recordId && corrected.version === 2 && corrected.text === correctedText);

    setStage('reconnect');
    reconnectClient = await connectMcpClient('memem-deployment-acceptance-reconnect', accessToken);
    setStage('search');
    const reconnectedSearch = await callTool(reconnectClient, 'search_memories', { text: marker, limit: 10 });
    requireCondition(Array.isArray(reconnectedSearch.memories) && reconnectedSearch.memories.length === 1);
    requireCondition(reconnectedSearch.memories[0].id === recordId && reconnectedSearch.memories[0].text === correctedText);

    const deletion = await callTool(primaryClient, 'forget_memory', { id: recordId, expectedVersion: corrected.version });
    requireCondition(deletion.deleted === true && deletion.id === recordId);
    setStage('delete');
    const afterDeletion = await callTool(primaryClient, 'search_memories', { text: marker, limit: 10 });
    requireCondition(Array.isArray(afterDeletion.memories) && afterDeletion.memories.length === 0);
    acceptanceOk = true;
  } catch {
    acceptanceOk = false;
    acceptanceFailureStage = currentStage;
  } finally {
    setStage('cleanup');
    cleanupOk = await cleanupRecord();
    if (!cleanupOk && !acceptanceFailureStage) acceptanceFailureStage = 'cleanup';
    for (const client of [reconnectClient, primaryClient]) {
      if (client) {
        try { await client.close(); } catch { /* Keep output limited to boolean results. */ }
      }
    }
    console.log(`remote_acceptance_ok=${acceptanceOk}`);
    console.log(`cleanup_ok=${cleanupOk}`);
    if (acceptanceFailureStage) console.log(`failed_stage=${acceptanceFailureStage}`);
    if (!cleanupOk && acceptanceFailureStage !== 'cleanup') console.log('cleanup_failed_stage=cleanup');
    if ((!acceptanceOk || !cleanupOk) && failedHttp !== null) {
      console.log(`failed_http_stage=${failedHttp.stage}`);
      console.log(`http_status=${failedHttp.status}`);
    }
    if (!acceptanceOk || !cleanupOk) process.exitCode = 1;
  }
}

await main();
