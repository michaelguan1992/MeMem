import { test, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import schemaSql from '../migrations/d1/0001_memories.sql?raw';
import mediaSql from '../migrations/d1/0002_media.sql?raw';
import { captureScript } from '../src/generated/capture-script.ts';

const origin = 'http://localhost:8787';
const ownerPassphrase = 'test-only-owner-secret-never-used-in-production';
const cookieName = '__Host-memem_session';
const loginCsp = "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'";
const captureCsp = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

async function migrate(): Promise<void> {
  for (const statement of `${schemaSql}\n${mediaSql}`.split(';').map((part) => part.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
async function hashValue(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}
function postForm(path: string, form: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request(`${origin}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, ...headers },
    body: new URLSearchParams(form).toString(),
  });
}
function cookieToken(setCookie: string | null): string {
  return setCookie?.match(/^__Host-memem_session=([A-Za-z0-9_-]{43});/)?.[1] ?? '';
}
async function signIn(): Promise<{ cookie: string; token: string }> {
  const response = await SELF.fetch(postForm('/capture/login', { password: ownerPassphrase }));
  expect(response.status).toBe(303);
  const token = cookieToken(response.headers.get('set-cookie'));
  expect(token).toHaveLength(43);
  return { cookie: `${cookieName}=${token}`, token };
}
async function fetchCapture(cookie?: string): Promise<string> {
  const response = await SELF.fetch(`${origin}/capture`, { headers: cookie ? { Cookie: cookie } : {} });
  return response.text();
}
function csrfFrom(html: string): string {
  return html.match(/<meta name="csrf-token" content="([A-Za-z0-9_-]+)">/)?.[1] ?? '';
}

test('GET /capture without a session shows the login page with hardened headers', async () => {
  await migrate();
  const response = await SELF.fetch(`${origin}/capture`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-security-policy')).toBe(loginCsp);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('x-frame-options')).toBe('DENY');
  expect(response.headers.get('referrer-policy')).toBe('same-origin');
  expect(response.headers.get('set-cookie')).toBeNull();
  const html = await response.text();
  expect(html).toContain('action="/capture/login"');
  expect(html).toContain('autocomplete="current-password"');
  expect(html).not.toContain('csrf-token');
  expect(await fetchCapture(`${cookieName}=not-a-session-token`)).toContain('action="/capture/login"');
});

test('login rejects wrong passphrases and cross-origin posts without issuing a cookie', async () => {
  await migrate();
  const wrong = await SELF.fetch(postForm('/capture/login', { password: 'incorrect-test-password' }));
  expect(wrong.status).toBe(401);
  expect(wrong.headers.get('set-cookie')).toBeNull();
  expect(wrong.headers.get('location')).toBeNull();
  const wrongHtml = await wrong.text();
  expect(wrongHtml).toContain('The owner passphrase is incorrect');
  expect(wrongHtml).not.toContain('csrf-token');

  for (const badOrigin of ['https://attacker.example', 'null']) {
    const response = await SELF.fetch(postForm('/capture/login', { password: ownerPassphrase }, { Origin: badOrigin }));
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('location')).toBeNull();
  }
});

test('correct passphrase sets a hardened session cookie, and D1 stores only hashes', async () => {
  await migrate();
  const response = await SELF.fetch(postForm('/capture/login', { password: ownerPassphrase }));
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe('/capture');
  const setCookie = response.headers.get('set-cookie') ?? '';
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=604800']) {
    expect(setCookie).toContain(attribute);
  }
  const token = cookieToken(setCookie);
  expect(token).toHaveLength(43);

  const rows = await env.DB.prepare('SELECT owner, token_hash, csrf_token_hash, created_at, expires_at FROM web_sessions WHERE token_hash = ?')
    .bind(await hashValue(token)).all();
  expect(rows.results).toHaveLength(1);
  const row = rows.results[0] as Record<string, string>;
  expect(row.owner).toBe('owner');
  expect(JSON.stringify(rows.results)).not.toContain(token);
  expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBe(sevenDaysMs);
  expect(row.csrf_token_hash).toBe(await hashValue(csrfFrom(await fetchCapture(`${cookieName}=${token}`))));
});

test('GET /capture with the session cookie renders the capture page with a CSRF token', async () => {
  await migrate();
  const { cookie } = await signIn();
  const response = await SELF.fetch(`${origin}/capture`, { headers: { Cookie: cookie } });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-security-policy')).toBe(captureCsp);
  const html = await response.text();
  const csrf = csrfFrom(html);
  expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(html).toContain('action="/capture/logout"');
  expect(html).toContain(`name="csrf" value="${csrf}"`);
  expect(html).not.toContain('autocomplete="current-password"');
});

test('logout needs the CSRF token, and a valid logout ends the session', async () => {
  await migrate();
  const { cookie } = await signIn();
  const csrf = csrfFrom(await fetchCapture(cookie));
  expect(csrf).not.toBe('');

  const wrong = await SELF.fetch(postForm('/capture/logout', { csrf: 'not-the-token' }, { Cookie: cookie }));
  expect(wrong.status).toBe(403);
  expect(wrong.headers.get('set-cookie')).toBeNull();
  expect(csrfFrom(await fetchCapture(cookie))).toBe(csrf);

  const absent = await SELF.fetch(postForm('/capture/logout', {}, { Cookie: cookie }));
  expect(absent.status).toBe(403);
  expect(csrfFrom(await fetchCapture(cookie))).toBe(csrf);

  const logout = await SELF.fetch(postForm('/capture/logout', { csrf }, { Cookie: cookie }));
  expect(logout.status).toBe(303);
  expect(logout.headers.get('location')).toBe('/capture');
  expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
  expect(await fetchCapture(cookie)).not.toContain('csrf-token');

  const again = await SELF.fetch(postForm('/capture/logout', { csrf }, { Cookie: cookie }));
  expect(again.status).toBe(303);
});

test('expired sessions show the login page, and the next sign-in prunes them', async () => {
  await migrate();
  const { cookie, token } = await signIn();
  await env.DB.prepare('UPDATE web_sessions SET expires_at = ? WHERE token_hash = ?')
    .bind(new Date(Date.now() - 1000).toISOString(), await hashValue(token)).run();
  const expired = await fetchCapture(cookie);
  expect(expired).toContain('action="/capture/login"');
  expect(expired).not.toContain('csrf-token');

  const fresh = await signIn();
  const leftover = await env.DB.prepare('SELECT token_hash FROM web_sessions WHERE token_hash = ?').bind(await hashValue(token)).all();
  expect(leftover.results).toHaveLength(0);
  expect(csrfFrom(await fetchCapture(fresh.cookie))).not.toBe('');
});

test('capture paths reject other methods with Allow', async () => {
  await migrate();
  const cases = [
    ['PUT', '/capture', 'GET'],
    ['POST', '/capture', 'GET'],
    ['GET', '/capture/login', 'POST'],
    ['PUT', '/capture/logout', 'POST'],
  ] as const;
  for (const [method, path, allow] of cases) {
    const response = await SELF.fetch(new Request(`${origin}${path}`, { method, headers: { Origin: origin } }));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe(allow);
  }
});

test('paths outside the capture surface keep their existing responses', async () => {
  await migrate();
  expect((await SELF.fetch(`${origin}/capture/unknown`)).status).toBe(404);
  const authorize = await SELF.fetch(`${origin}/authorize`);
  expect(authorize.status).toBe(400);
  expect(await authorize.text()).toContain('The authorization request is invalid');
  const mcp = await SELF.fetch(`${origin}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  expect(mcp.status).toBe(401);
});

test('the signed-in capture page is the real form, with its script, manifest and policy', async () => {
  await migrate();
  const { cookie } = await signIn();
  const response = await SELF.fetch(`${origin}/capture`, { headers: { Cookie: cookie } });
  expect(response.headers.get('content-security-policy')).toBe(captureCsp);
  const html = await response.text();
  for (const expected of [
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<link rel="manifest" href="/capture.webmanifest">',
    '<link rel="apple-touch-icon" href="/capture-icon.svg">',
    '<script src="/capture.js" defer></script>',
    '<form id="capture-form" method="post" action="/capture" novalidate>',
    '<textarea id="entry-text"',
    'type="datetime-local"',
    'accept="image/*" multiple',
    'id="related-list"',
    'id="save-button"',
    'id="status"',
    'action="/capture/logout"',
  ]) expect(html).toContain(expected);
  expect(html).not.toContain('Capture tools will appear here');
  expect(html).not.toContain(' onclick=');
  expect(html).not.toContain(' onsubmit=');
  expect(html).not.toContain('<script>');
});

test('the login page loads no script and its policy has no script-src', async () => {
  await migrate();
  const response = await SELF.fetch(`${origin}/capture`);
  const policy = response.headers.get('content-security-policy') ?? '';
  expect(policy).toBe(loginCsp);
  expect(policy).not.toContain('script-src');
  const html = await response.text();
  expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
  expect(html).not.toContain('<script');
  expect(html).not.toContain('/capture.js');
});

test('capture static files are public, typed, and served with nosniff', async () => {
  await migrate();
  const script = await SELF.fetch(`${origin}/capture.js`);
  expect(script.status).toBe(200);
  expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  expect(script.headers.get('x-content-type-options')).toBe('nosniff');
  expect(script.headers.get('cache-control')).toBe('no-cache');
  const source = await script.text();
  expect(source).toBe(captureScript);
  expect(source).toContain('/api/media');
  // A bundler helper such as esbuild's __name( would be undefined in the browser.
  expect(source).not.toContain('__name(');

  const manifest = await SELF.fetch(`${origin}/capture.webmanifest`);
  expect(manifest.status).toBe(200);
  expect(manifest.headers.get('content-type')).toBe('application/manifest+json');
  expect(manifest.headers.get('x-content-type-options')).toBe('nosniff');
  expect(await manifest.json()).toMatchObject({
    name: 'MeMem',
    short_name: 'MeMem',
    start_url: '/capture',
    display: 'standalone',
    icons: [{ src: '/capture-icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  });

  const icon = await SELF.fetch(`${origin}/capture-icon.svg`);
  expect(icon.status).toBe(200);
  expect(icon.headers.get('content-type')).toBe('image/svg+xml');
  expect(icon.headers.get('x-content-type-options')).toBe('nosniff');
  expect(icon.headers.get('content-security-policy')).toBe("default-src 'none'");
  expect(await icon.text()).toContain('<svg');
});

test('capture static files reject every method except GET', async () => {
  await migrate();
  for (const path of ['/capture.js', '/capture.webmanifest', '/capture-icon.svg']) {
    const response = await SELF.fetch(new Request(`${origin}${path}`, { method: 'POST', headers: { Origin: origin } }));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  }
});

test('login refuses an oversized body with 413 and a non-form body with 400, and issues no cookie', async () => {
  await migrate();
  const oversized = await SELF.fetch(postForm('/capture/login', { password: 'x'.repeat(5000) }));
  expect(oversized.status).toBe(413);
  expect(oversized.headers.get('set-cookie')).toBeNull();
  expect(await oversized.text()).toContain('Request too large.');

  const notAForm = await SELF.fetch(new Request(`${origin}/capture/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ password: ownerPassphrase }),
  }));
  expect(notAForm.status).toBe(400);
  expect(notAForm.headers.get('set-cookie')).toBeNull();
  expect(await notAForm.text()).toContain('Invalid form.');
});

test('pages are served over HTTPS, and plain HTTP is served only to this machine', async () => {
  expect((await SELF.fetch('https://memem.example/capture')).status).toBe(200);
  expect((await SELF.fetch(`${origin}/capture`)).status).toBe(200);
  const plain = await SELF.fetch('http://memem.example/capture');
  expect(plain.status).toBe(403);
  expect(await plain.text()).toBe('HTTPS is required');
});
