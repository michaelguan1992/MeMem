import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const secretDirectory = resolve(root, '.secrets');
const outputPaths = [resolve(secretDirectory, 'owner-passphrase'), resolve(secretDirectory, 'owner-password-hash'), resolve(root, '.dev.vars')];
const alreadyPresent = outputPaths.filter((path) => existsSync(path));
if (alreadyPresent.length) {
  throw new Error(`Refusing to overwrite existing credential files: ${alreadyPresent.map((path) => path.replace(`${root}/`, '')).join(', ')}. Move or remove them deliberately before generating new credentials.`);
}
mkdirSync(secretDirectory, { recursive: true, mode: 0o700 });
chmodSync(secretDirectory, 0o700);

const passphrase = randomBytes(32).toString('base64url');
const salt = randomBytes(16);
const digest = createHash('sha256').update(salt).update(passphrase, 'utf8').digest();
const passwordHash = `sha256-v1$${salt.toString('base64url')}$${digest.toString('base64url')}`;

function writePrivate(path, contents) {
  writeFileSync(path, contents, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}

writePrivate(resolve(secretDirectory, 'owner-passphrase'), `${passphrase}\n`);
writePrivate(resolve(secretDirectory, 'owner-password-hash'), `${passwordHash}\n`);
writePrivate(resolve(root, '.dev.vars'), `OWNER_PASSWORD_HASH="${passwordHash}"\n`);
console.log('Created local owner credentials in mode-0600 files. Open .secrets/owner-passphrase locally when you need the generated passphrase; it was not printed here.');
