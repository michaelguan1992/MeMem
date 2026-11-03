import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const configPath = resolve(root, 'wrangler.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const production = config.env?.production;
if (!production) throw new Error('wrangler.json must define env.production.');

const vars = production.vars ?? {};
const resource = vars.MCP_RESOURCE_URL;
const issuer = vars.OAUTH_ISSUER;
if (typeof resource !== 'string' || typeof issuer !== 'string') throw new Error('Set production MCP_RESOURCE_URL and OAUTH_ISSUER.');
const resourceUrl = new URL(resource);
const issuerUrl = new URL(issuer);
if (resourceUrl.protocol !== 'https:' || issuerUrl.protocol !== 'https:' || resourceUrl.origin !== issuerUrl.origin || resourceUrl.pathname !== '/mcp' || resourceUrl.search || resourceUrl.hash || issuerUrl.pathname !== '/' || issuerUrl.search || issuerUrl.hash) {
  throw new Error('Production OAuth issuer and MCP_RESOURCE_URL must use one HTTPS origin, with the canonical resource path /mcp.');
}
if (resource.includes('<') || resource.includes('>') || issuer.includes('<') || issuer.includes('>')) throw new Error('Replace the production URL placeholders in wrangler.json.');

const [database] = production.d1_databases ?? [];
const [namespace] = production.kv_namespaces ?? [];
const databaseId = database?.database_id ?? '';
const databaseIdIsUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId);
if (database?.binding !== 'DB' || database?.database_name !== 'memem' || !databaseIdIsUuid || /^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(databaseId) || /^1{8}-1{4}-1{4}-1{4}-1{12}$/i.test(databaseId)) {
  throw new Error('Set a valid production D1 database_id for the DB binding in wrangler.json.');
}
const namespaceId = namespace?.id ?? '';
if (namespace?.binding !== 'OAUTH_KV' || !/^[0-9a-f]{32}$/i.test(namespaceId) || /^0{32}$/.test(namespaceId) || /^1{32}$/.test(namespaceId)) {
  throw new Error('Set a valid production KV namespace ID for the OAUTH_KV binding in wrangler.json.');
}

const secretDirectory = resolve(root, '.secrets');
const hashPath = resolve(secretDirectory, 'owner-password-hash');
const passphrasePath = resolve(secretDirectory, 'owner-passphrase');
const secretFileStat = statSync(hashPath);
const passphraseStat = statSync(passphrasePath);
const directoryStat = statSync(secretDirectory);
if ((secretFileStat.mode & 0o777) !== 0o600 || (passphraseStat.mode & 0o777) !== 0o600 || (directoryStat.mode & 0o777) !== 0o700) {
  throw new Error('Secure owner credentials must have a 0700 .secrets directory and 0600 files; rerun setup after correcting permissions.');
}
const passwordHash = readFileSync(hashPath, 'utf8').trim();
// `$` (deployed form) or `.` (written by setup-secrets now). The backreference keeps one separator per value.
if (!/^sha256-v1([$.])[A-Za-z0-9_-]{22}\1[A-Za-z0-9_-]{43}$/.test(passwordHash)) throw new Error('The owner password hash file has an invalid format.');

console.log('Production config, HTTPS audience, D1/KV IDs, and local secret permissions are valid.');
