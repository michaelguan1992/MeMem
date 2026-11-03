import { MemoryError } from './errors.ts';

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const invalid = (message: string): never => { throw new MemoryError('INVALID_INPUT', message); };
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) invalid('Invalid record identifier');
  return value as string;
}
export function instant(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    invalid('Time must be an ISO timestamp with timezone');
  }
  return new Date(value as string).toISOString();
}
export function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid('Expected a positive record version');
  return value as number;
}
export function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalid('SHA-256 must be 64 lowercase hex characters');
  return value as string;
}
/** Lowercase hex of a buffer, the form that `digest` accepts. */
export const toHex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
