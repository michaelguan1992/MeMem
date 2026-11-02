export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}
export async function verifyOwnerPassword(password: string, storedHash: string): Promise<boolean> {
  const [version, saltPart, digestPart, extra] = storedHash.split('$');
  if (version !== 'sha256-v1' || !saltPart || !digestPart || extra !== undefined || password.length > 512) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = base64UrlToBytes(saltPart);
    expected = base64UrlToBytes(digestPart);
  } catch { return false; }
  if (salt.length !== 16 || expected.length !== 32) return false;
  const passwordBytes = new TextEncoder().encode(password);
  const combined = new Uint8Array(salt.length + passwordBytes.length);
  combined.set(salt);
  combined.set(passwordBytes, salt.length);
  const actual = new Uint8Array(await crypto.subtle.digest('SHA-256', combined));
  return constantTimeEqual(actual, expected);
}
