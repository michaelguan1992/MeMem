import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyOwnerPassword } from '../src/platform/owner-password.ts';

// Test-only passphrase and salt. The verifier is built the way scripts/setup-secrets.mjs builds one: SHA-256 over the
// 16-byte salt followed by the passphrase, with the salt and digest in base64url.
const PASSPHRASE = 'owner-password-test-only-passphrase';
const SALT_TEXT = Buffer.from('0123456789abcdef').toString('base64url');
const DIGEST_TEXT = createHash('sha256').update(Buffer.from(SALT_TEXT, 'base64url')).update(PASSPHRASE, 'utf8').digest('base64url');
const dollarForm = `sha256-v1$${SALT_TEXT}$${DIGEST_TEXT}`;
const dotForm = `sha256-v1.${SALT_TEXT}.${DIGEST_TEXT}`;

test('the $ form that is already deployed still verifies the passphrase', async () => {
  assert.equal(await verifyOwnerPassword(PASSPHRASE, dollarForm), true);
});

test('the . form verifies the same passphrase', async () => {
  assert.equal(await verifyOwnerPassword(PASSPHRASE, dotForm), true);
});

test('a wrong passphrase fails in the $ form', async () => {
  assert.equal(await verifyOwnerPassword('not the owner passphrase', dollarForm), false);
});

test('a wrong passphrase fails in the . form', async () => {
  assert.equal(await verifyOwnerPassword('not the owner passphrase', dotForm), false);
});

test('a verifier that mixes the two separators is rejected in either order', async () => {
  assert.equal(await verifyOwnerPassword(PASSPHRASE, `sha256-v1$${SALT_TEXT}.${DIGEST_TEXT}`), false);
  assert.equal(await verifyOwnerPassword(PASSPHRASE, `sha256-v1.${SALT_TEXT}$${DIGEST_TEXT}`), false);
});

test('extra parts are rejected in both forms', async () => {
  assert.equal(await verifyOwnerPassword(PASSPHRASE, `${dollarForm}$extra`), false);
  assert.equal(await verifyOwnerPassword(PASSPHRASE, `${dotForm}.extra`), false);
});

test('a missing part, an unknown version or a wrong-length salt is rejected', async () => {
  assert.equal(await verifyOwnerPassword(PASSPHRASE, `sha256-v1.${SALT_TEXT}`), false);
  assert.equal(await verifyOwnerPassword(PASSPHRASE, `sha256-v2.${SALT_TEXT}.${DIGEST_TEXT}`), false);
  assert.equal(await verifyOwnerPassword(PASSPHRASE, `sha256-v1.${DIGEST_TEXT}.${DIGEST_TEXT}`), false);
});

test('a digest that differs from the right one only in its first byte is refused', async () => {
  const digest = createHash('sha256').update(Buffer.from(SALT_TEXT, 'base64url')).update(PASSPHRASE, 'utf8').digest();
  digest[0] ^= 0x01;
  assert.equal(await verifyOwnerPassword(PASSPHRASE, `sha256-v1.${SALT_TEXT}.${digest.toString('base64url')}`), false);
});

test('a digest that is not valid base64url is refused rather than thrown', async () => {
  assert.equal(await verifyOwnerPassword(PASSPHRASE, `sha256-v1.${SALT_TEXT}.!!!!`), false);
});

test('a salt that is not 16 bytes is refused even when the digest over it matches', async () => {
  const salt = Buffer.from('01234567');
  const digest = createHash('sha256').update(salt).update(PASSPHRASE, 'utf8').digest('base64url');
  assert.equal(await verifyOwnerPassword(PASSPHRASE, `sha256-v1.${salt.toString('base64url')}.${digest}`), false);
});

test('a passphrase of 512 characters verifies, and one of 513 characters is refused', async () => {
  const salt = Buffer.from('0123456789abcdef');
  const verifierFor = (passphrase: string) => `sha256-v1.${salt.toString('base64url')}.${createHash('sha256').update(salt).update(passphrase, 'utf8').digest('base64url')}`;
  const longest = 'p'.repeat(512);
  assert.equal(await verifyOwnerPassword(longest, verifierFor(longest)), true);
  const tooLong = 'p'.repeat(513);
  assert.equal(await verifyOwnerPassword(tooLong, verifierFor(tooLong)), false);
});
