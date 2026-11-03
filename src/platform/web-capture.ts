import type { D1Binding } from '../storage/d1.ts';
import { captureScript } from '../generated/capture-script.ts';
import { htmlEscape, PayloadTooLargeError, readBoundedForm, sameOriginPost } from './http.ts';
import { verifyOwnerPassword } from './owner-password.ts';
import { checkCsrf, clearSessionCookie, createSession, destroySession, readSession, SESSION_MAX_AGE_SECONDS, sessionCookie, type WebSession } from './web-session.ts';

// The login and message pages run no script, so they keep the policy without script-src.
const loginCsp = "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'";
const captureCsp = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
function htmlHeaders(contentSecurityPolicy: string): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // no-referrer makes browsers send `Origin: null` on same-origin POSTs, which sameOriginPost rejects.
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': contentSecurityPolicy,
  };
}
const loginHeaders = htmlHeaders(loginCsp);
const captureHeaders = htmlHeaders(captureCsp);
const staticHeaders = { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
const capturePaths = new Set(['/capture', '/capture/login', '/capture/logout', '/capture.js', '/capture.webmanifest', '/capture-icon.svg']);

// Public static files: they hold no data and do not need a session.
const manifest = JSON.stringify({
  name: 'MeMem',
  short_name: 'MeMem',
  start_url: '/capture',
  display: 'standalone',
  background_color: '#f5f5f2',
  theme_color: '#2d6a5a',
  icons: [{ src: '/capture-icon.svg', sizes: 'any', type: 'image/svg+xml' }],
});
const iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#2d6a5a"/><path d="M120 392V120h80l56 110 56-110h80v272h-64V232l-72 118-72-118v160z" fill="#ffffff"/></svg>';

const captureStyles = `
:root { color-scheme: light dark; --bg: #f5f5f2; --panel: #ffffff; --ink: #1d1d1b; --muted: #62625b; --line: #cfcfc5; --accent: #2d6a5a; --accent-ink: #ffffff; --danger: #a33a2b; --focus: #1f5fbf; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #161615; --panel: #232320; --ink: #f1f1ec; --muted: #a9a99f; --line: #3d3d37; --accent: #62b59f; --accent-ink: #0e1f19; --danger: #ff9584; --focus: #8ab4ff; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 17px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
main { max-width: 640px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { margin: 0 0 20px; font-size: 1.5rem; }
form { margin: 0; }
#capture-form { display: grid; gap: 20px; }
.field { display: grid; gap: 8px; min-width: 0; }
.field > label { font-weight: 600; }
textarea, input[type="datetime-local"] { width: 100%; min-height: 48px; padding: 10px 12px; font: inherit; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
textarea { min-height: 9em; resize: vertical; }
input[type="file"] { width: 100%; min-height: 48px; font: inherit; color: var(--ink); }
#related { min-width: 0; margin: 0; padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
legend { padding: 0 4px; font-weight: 600; }
.choices { display: grid; gap: 2px; }
.group-title { margin: 10px 0 2px; font-size: 0.8rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.choice { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 6px 4px; }
.choice input { flex: none; width: 22px; height: 22px; margin: 0; accent-color: var(--accent); }
.photos { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.photo { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 12px; align-items: center; padding: 8px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
.photo img { width: 64px; height: 64px; object-fit: cover; border-radius: 8px; background: var(--line); }
.photo > div { min-width: 0; }
.photo .name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.photo .status { display: block; font-size: 0.9rem; color: var(--muted); }
.photo[data-state="saved"] .status { color: var(--accent); }
.photo[data-state="failed"] .status { color: var(--danger); }
button { min-height: 48px; padding: 0 18px; font: inherit; font-weight: 600; border: 0; border-radius: 12px; cursor: pointer; }
#save-button { width: 100%; background: var(--accent); color: var(--accent-ink); }
button:disabled, textarea:disabled, input:disabled { opacity: 0.55; cursor: default; }
#status { min-height: 1.5em; margin: 16px 0 0; }
#status.error { color: var(--danger); }
.saved { display: flex; flex-wrap: wrap; gap: 12px; margin: 16px 0 0; }
.saved figure { width: 96px; margin: 0; }
.saved img { display: block; width: 96px; height: 96px; object-fit: cover; border-radius: 12px; background: var(--line); }
.saved figcaption { margin-top: 4px; font-size: 0.8rem; color: var(--muted); }
.logout { margin-top: 36px; }
.logout button { color: var(--muted); background: transparent; border: 1px solid var(--line); }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
`;

function capturePage(csrf: string): string {
  const token = htmlEscape(csrf);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="csrf-token" content="${token}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="color-scheme" content="light dark">
<title>MeMem capture</title>
<link rel="manifest" href="/capture.webmanifest">
<link rel="apple-touch-icon" href="/capture-icon.svg">
<style>${captureStyles}</style>
<script src="/capture.js" defer></script>
</head>
<body>
<main>
<h1>MeMem capture</h1>
<noscript><p>MeMem capture needs JavaScript to prepare photos before upload.</p></noscript>
<form id="capture-form" method="post" action="/capture" novalidate>
<div class="field">
<label for="entry-text">What happened?</label>
<textarea id="entry-text" name="text" rows="6"></textarea>
</div>
<div class="field">
<label for="entry-when">When</label>
<input id="entry-when" name="occurredAt" type="datetime-local">
</div>
<div class="field">
<label for="entry-photos">Photos</label>
<input id="entry-photos" name="photos" type="file" accept="image/*" multiple>
<ul id="photo-list" class="photos"></ul>
</div>
<fieldset id="related">
<legend>People and places</legend>
<div id="related-list" class="choices">Loading…</div>
</fieldset>
<button id="save-button" type="submit">Save entry</button>
</form>
<p id="status" role="status" aria-live="polite"></p>
<div id="saved-photos" class="saved"></div>
<form method="post" action="/capture/logout" class="logout">
<input type="hidden" name="csrf" value="${token}">
<button type="submit">Log out</button>
</form>
</main>
</body>
</html>`;
}
function htmlResponse(body: string, status = 200, headers: Record<string, string> = loginHeaders): Response {
  return new Response(body, { status, headers });
}
function messagePage(message: string, status: number): Response {
  return htmlResponse(`<!doctype html><html lang="en"><meta charset="utf-8"><title>MeMem capture</title><h1>MeMem capture</h1><p>${htmlEscape(message)}</p>`, status);
}
function loginPage(errorMessage = ''): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MeMem capture</title><h1>MeMem capture</h1><form method="post" action="/capture/login"><p><label>Owner passphrase: <input type="password" name="password" autocomplete="current-password" required></label></p>${errorMessage ? `<p role="alert">${htmlEscape(errorMessage)}</p>` : ''}<p><button type="submit">Sign in</button></p></form></html>`;
}
function redirectToCapture(setCookie: string): Response {
  return new Response(null, { status: 303, headers: { Location: '/capture', 'Set-Cookie': setCookie, 'Cache-Control': 'no-store' } });
}
function methodNotAllowed(allow: string): Response {
  return new Response('Method not allowed', { status: 405, headers: { Allow: allow } });
}
function staticFile(request: Request, body: string, contentType: string, extra: Record<string, string> = {}): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  return new Response(body, { headers: { 'Content-Type': contentType, ...staticHeaders, ...extra } });
}
async function currentSession(db: D1Binding, request: Request, owner: string, now: Date): Promise<WebSession | null> {
  const session = await readSession(db, request, now);
  return session?.owner === owner ? session : null;
}

export async function handleCapture(request: Request, env: { DB: D1Binding; OWNER_PASSWORD_HASH: string }, owner: string): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!capturePaths.has(pathname)) return null;
  if (pathname === '/capture.js') return staticFile(request, captureScript, 'text/javascript; charset=utf-8');
  if (pathname === '/capture.webmanifest') return staticFile(request, manifest, 'application/manifest+json');
  if (pathname === '/capture-icon.svg') return staticFile(request, iconSvg, 'image/svg+xml', { 'Content-Security-Policy': "default-src 'none'" });
  const now = new Date();
  if (pathname === '/capture') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    const session = await currentSession(env.DB, request, owner, now);
    return session ? htmlResponse(capturePage(session.csrf), 200, captureHeaders) : htmlResponse(loginPage());
  }
  if (pathname === '/capture/login') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    if (!sameOriginPost(request)) return messagePage('Request origin check failed. Reload the page and try again.', 403);
    let form: URLSearchParams;
    try { form = await readBoundedForm(request, 4096); }
    catch (error) {
      return error instanceof PayloadTooLargeError ? htmlResponse(loginPage('Request too large.'), 413) : htmlResponse(loginPage('Invalid form.'), 400);
    }
    const password = form.get('password');
    if (!password || !await verifyOwnerPassword(password, env.OWNER_PASSWORD_HASH)) {
      return htmlResponse(loginPage('The owner passphrase is incorrect. Try again.'), 401);
    }
    const { token } = await createSession(env.DB, owner, now);
    return redirectToCapture(sessionCookie(token, SESSION_MAX_AGE_SECONDS));
  }
  if (request.method !== 'POST') return methodNotAllowed('POST');
  if (!sameOriginPost(request)) return messagePage('Request origin check failed. Reload the page and try again.', 403);
  const session = await currentSession(env.DB, request, owner, now);
  if (!session) return redirectToCapture(clearSessionCookie());
  let form: URLSearchParams;
  try { form = await readBoundedForm(request, 4096); }
  catch (error) {
    return error instanceof PayloadTooLargeError ? messagePage('Request too large.', 413) : messagePage('Invalid form.', 400);
  }
  if (!await checkCsrf(session, form.get('csrf'))) return messagePage('This logout request is invalid. Reload the page and try again.', 403);
  await destroySession(env.DB, session.tokenHash);
  return redirectToCapture(clearSessionCookie());
}
