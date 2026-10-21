#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const secretDirectory = resolve(root, '.secrets');
const tokenPath = resolve(secretDirectory, 'cloudflare-api-token');
const accountId = '8d5a4c2693eb545e17dd38a66492a13e';
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node scripts/wrangler-cloudflare.mjs <wrangler arguments>');
  process.exit(2);
}

try {
  const directoryStat = lstatSync(secretDirectory);
  const tokenStat = lstatSync(tokenPath);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o777) !== 0o700) {
    throw new Error('The .secrets directory must be a real directory with mode 0700.');
  }
  if (!tokenStat.isFile() || tokenStat.isSymbolicLink() || (tokenStat.mode & 0o777) !== 0o600) {
    throw new Error('The Cloudflare token file must be a regular file with mode 0600.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Could not validate the local Cloudflare token file.');
  process.exit(1);
}

const token = readFileSync(tokenPath, 'utf8');
if (!token || /[\r\n]/.test(token)) {
  console.error('The local Cloudflare token file is empty or has an invalid format.');
  process.exit(1);
}

const result = spawnSync('npx', ['wrangler', ...args], {
  cwd: root,
  env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId },
  stdio: 'inherit',
});
if (result.error) {
  console.error(`Could not start Wrangler: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
