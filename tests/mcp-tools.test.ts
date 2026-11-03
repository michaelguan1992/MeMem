import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client-current';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { MemoryStore } from '../src/core/contracts.ts';
import { createMemoryService } from '../src/core/service.ts';
import { createMemoryMcpServer } from '../src/mcp/tools.ts';
import { openSqliteStore } from '../src/storage/sqlite.ts';

/** Connects a real MCP client to the tool server over an in-memory transport, with both scopes granted. */
async function connect(store: MemoryStore) {
  const service = createMemoryService({ store, owner: 'alice', newId: () => 'unused', now: () => '2026-10-09T12:00:00Z' });
  const server = createMemoryMcpServer(service, { scopes: ['memory:read', 'memory:write'], resourceUrl: new URL('http://localhost:8787/mcp') });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'mcp-tools-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('MCP tools/list input schemas match the checked-in contract', async () => {
  const db = openSqliteStore(':memory:');
  try {
    const { client, close } = await connect(db.store);
    const listed = await client.listTools();
    const contract: unknown = JSON.parse(readFileSync(new URL('./fixtures/mcp-tool-input-schemas.json', import.meta.url), 'utf8'));
    assert.deepEqual(Object.fromEntries(listed.tools.map((tool) => [tool.name, tool.inputSchema])), contract);
    await close();
  } finally { db.close(); }
});

test('MCP tool inputs refuse an owner or any other unknown key', async () => {
  const db = openSqliteStore(':memory:');
  try {
    const { client, close } = await connect(db.store);
    const refused = await client.callTool({ name: 'record_memory', arguments: { kind: 'fact', text: 'x', owner: 'mallory' } });
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused.content), /Unrecognized key/);
    assert.deepEqual(await db.store.list('alice', { limit: 10 }), []);
    await close();
  } finally { db.close(); }
});

test('a rejected tool input names the field that failed', async () => {
  const db = openSqliteStore(':memory:');
  try {
    const { client, close } = await connect(db.store);
    const refused = await client.callTool({ name: 'record_memory', arguments: { kind: 'diary', text: 'x' } });
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused.content), /输入无效：kind Unknown memory kind/);
    await close();
  } finally { db.close(); }
});

test('the server tells clients that its tool list does not change', async () => {
  const db = openSqliteStore(':memory:');
  try {
    const { client, close } = await connect(db.store);
    assert.equal(client.getServerCapabilities()?.tools?.listChanged, false);
    await close();
  } finally { db.close(); }
});
