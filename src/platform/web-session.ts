import type { D1Binding } from '../storage/d1.ts';
import { constantTimeEqual } from './owner-password.ts';

export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const COOKIE_NAME = '__Host-memem_session';

export interface WebSession {
  owner: string;
  csrf: string;
  tokenHash: string;
  csrfTokenHash: string;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
async function hashValue(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}
// The CSRF value is derived from the cookie token, so the page can re-render it without D1 storing it.
async function csrfFor(token: string): Promise<string> {
  return hashValue(`memem-csrf\0${token}`);
}
function cookieValue(header: string | null, name: string): string | null {
  for (const pair of (header ?? '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator !== -1 && pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim();
  }
  return null;
}
async function runWrite(db: D1Binding, sql: string, args: string[]): Promise<void> {
  const result = await db.prepare(sql).bind(...args).run();
  if (!result.success) throw new Error('D1 write failed');
}

export async function createSession(db: D1Binding, owner: string, now: Date): Promise<{ token: string; csrf: string; expiresAt: Date }> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const csrf = await csrfFor(token);
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000);
  await runWrite(db, 'DELETE FROM web_sessions WHERE expires_at < ?', [now.toISOString()]);
  await runWrite(db, 'INSERT INTO web_sessions (token_hash, owner, csrf_token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    [await hashValue(token), owner, await hashValue(csrf), now.toISOString(), expiresAt.toISOString()]);
  return { token, csrf, expiresAt };
}

export async function readSession(db: D1Binding, request: Request, now: Date): Promise<WebSession | null> {
  const token = cookieValue(request.headers.get('Cookie'), COOKIE_NAME);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const tokenHash = await hashValue(token);
  const result = await db.prepare('SELECT owner, csrf_token_hash FROM web_sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(tokenHash, now.toISOString()).all();
  if (!result.success) throw new Error('D1 read failed');
  const row = result.results[0];
  if (!row || typeof row.owner !== 'string' || typeof row.csrf_token_hash !== 'string') return null;
  return { owner: row.owner, csrf: await csrfFor(token), tokenHash, csrfTokenHash: row.csrf_token_hash };
}

export async function checkCsrf(session: WebSession, submitted: string | null): Promise<boolean> {
  if (!submitted) return false;
  const actual = new TextEncoder().encode(await hashValue(submitted));
  return constantTimeEqual(actual, new TextEncoder().encode(session.csrfTokenHash));
}

export async function destroySession(db: D1Binding, tokenHash: string): Promise<void> {
  await runWrite(db, 'DELETE FROM web_sessions WHERE token_hash = ?', [tokenHash]);
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
