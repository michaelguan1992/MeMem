import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { seedPersonRow } from './support/d1.ts';
import { expect, test } from './support/fixtures.ts';
import { jpegSize } from './support/jpeg.ts';
import { EXIF_PHOTO } from './support/paths.ts';
import { OWNER_PASSPHRASE, SAVE_BUTTON, expectStatus, rowsWithText, signIn, uniqueText } from './support/owner.ts';

const UNREACHABLE = 'Could not reach MeMem. Check the connection; what you typed is still here.';

/**
 * Replaces the browser's speech recognition with a fake before the page's scripts run, and removes the WebKit one. Each
 * instance the page creates is kept on window.__fakeSpeech, so a test can read what the page set and fire the handlers.
 */
async function fakeSpeechRecognition(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const instances: unknown[] = [];
    class FakeRecognition {
      lang = '';
      continuous = false;
      interimResults = false;
      started = 0;
      stopped = 0;
      constructor() { instances.push(this); }
      start(): void { this.started += 1; }
      stop(): void { this.stopped += 1; }
    }
    Object.defineProperty(window, 'SpeechRecognition', { value: FakeRecognition, configurable: true, writable: true });
    delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    Object.defineProperty(window, '__fakeSpeech', { value: instances });
  });
}

interface RecognitionView {
  count: number;
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  started: number;
  stopped: number;
}

/** The recognition the page created last: the settings it set, and how often the page started and stopped it. */
async function latestRecognition(page: Page): Promise<RecognitionView> {
  return page.evaluate((): RecognitionView => {
    const all = (window as unknown as { __fakeSpeech: Array<Record<string, unknown>> }).__fakeSpeech;
    const latest = all[all.length - 1] ?? {};
    return {
      count: all.length,
      lang: String(latest.lang ?? ''),
      continuous: latest.continuous === true,
      interimResults: latest.interimResults === true,
      started: Number(latest.started ?? 0),
      stopped: Number(latest.stopped ?? 0),
    };
  });
}

/** Calls one of the page's handlers on the recognition the page created last, as the browser would. */
async function fireHandler(page: Page, handler: 'onresult' | 'onerror' | 'onend', argument?: unknown): Promise<void> {
  await page.evaluate(([name, value]) => {
    const all = (window as unknown as { __fakeSpeech: Array<Record<string, ((value?: unknown) => void) | undefined>> }).__fakeSpeech;
    all[all.length - 1][name]?.(value);
  }, [handler, argument] as const);
}

/** The browser reports these results: each is final or interim, and only final text goes into the entry. */
async function hear(page: Page, results: Array<{ isFinal: boolean; transcript: string }>): Promise<void> {
  await fireHandler(page, 'onresult', {
    resultIndex: 0,
    results: results.map((result) => ({ isFinal: result.isFinal, 0: { transcript: result.transcript } })),
  });
}

test('a wrong passphrase is refused, and the right one opens the capture form', async ({ page }) => {
  await page.goto('/capture');
  await page.getByLabel('Owner passphrase').fill('not the owner passphrase');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('The owner passphrase is incorrect. Try again.');
  await expect(page.getByLabel('What happened?', { exact: true })).toHaveCount(0);

  await page.getByLabel('Owner passphrase').fill(OWNER_PASSPHRASE);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByLabel('What happened?', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: SAVE_BUTTON })).toBeVisible();
});

test('a photo sets the When field from its EXIF time, and the saved photo keeps its three sizes', async ({ page }) => {
  const text = uniqueText('Ferry to the harbour');
  await signIn(page);
  await page.getByLabel('Photos', { exact: true }).setInputFiles(EXIF_PHOTO);
  await expect(page.getByLabel('When', { exact: true })).toHaveValue('2024-05-01T14:30');

  await page.getByLabel('What happened?', { exact: true }).fill(text);
  const [entryRequest] = await Promise.all([
    page.waitForRequest((candidate) => candidate.url().endsWith('/api/entries') && candidate.method() === 'POST'),
    page.getByRole('button', { name: SAVE_BUTTON }).click(),
  ]);
  // The page sends the EXIF time with the photo's own offset.
  expect(entryRequest.postDataJSON()).toMatchObject({ occurredAt: '2024-05-01T14:30:00+09:00' });
  await expectStatus(page, 'Saved.', false);
  await expect(page.getByRole('button', { name: SAVE_BUTTON })).toBeEnabled();

  const thumbnail = page.locator('#saved-photos img');
  await expect(thumbnail).toHaveCount(1);
  await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);

  const src = await thumbnail.getAttribute('src');
  const id = src?.match(/^\/api\/media\/([^/]+)\/thumb$/)?.[1];
  expect(id, 'the thumbnail URL names the photo').toBeTruthy();

  const original = await page.request.get(`/api/media/${id}/original`);
  expect(original.status()).toBe(200);
  expect(Buffer.compare(await original.body(), await readFile(EXIF_PHOTO))).toBe(0);

  const display = await page.request.get(`/api/media/${id}/display`);
  expect(display.status()).toBe(200);
  expect(display.headers()['content-type']).toBe('image/jpeg');
  expect(jpegSize(await display.body())).toEqual({ width: 1600, height: 1067 });

  const thumb = await page.request.get(`/api/media/${id}/thumb`);
  expect(thumb.status()).toBe(200);
  expect(jpegSize(await thumb.body())).toEqual({ width: 400, height: 267 });

  // The server stores the same instant in UTC: 14:30 at +09:00 is 05:30Z.
  const rows = await rowsWithText(text);
  expect(rows.map((row) => row.occurred_at)).toEqual(['2024-05-01T05:30:00.000Z']);
});

test('a save whose response is lost is retried, and the entry is stored once', async ({ page }) => {
  const text = uniqueText('Lost response check');
  await signIn(page);

  let dropped = false;
  await page.route('**/api/entries', async (route) => {
    if (dropped) return route.continue();
    dropped = true;
    await route.fetch(); // the server stores the entry
    await route.abort(); // the page never receives the response
  });

  await page.getByLabel('What happened?', { exact: true }).fill(text);
  await page.getByRole('button', { name: SAVE_BUTTON }).click();
  await expectStatus(page, UNREACHABLE, true);

  await page.getByRole('button', { name: SAVE_BUTTON }).click();
  await expectStatus(page, 'Saved.', false);
  expect(await rowsWithText(text)).toHaveLength(1);
});

test('a person saved through the API is listed under People and places, and is sent as a related id', async ({ page }) => {
  await signIn(page);
  const name = uniqueText('Friend Ana');
  const personId = await seedPersonRow(name);
  await page.reload();
  await expect(page.getByRole('group', { name: 'People and places' })).toBeVisible();
  await expect(page.getByLabel(name, { exact: true })).toBeVisible();

  const text = uniqueText('Lunch with Ana');
  await page.getByLabel(name, { exact: true }).check();
  await page.getByLabel('What happened?', { exact: true }).fill(text);
  const [request] = await Promise.all([
    page.waitForRequest((candidate) => candidate.url().endsWith('/api/entries') && candidate.method() === 'POST'),
    page.getByRole('button', { name: SAVE_BUTTON }).click(),
  ]);
  expect(request.postDataJSON()).toMatchObject({ text, relatedIds: [personId] });
  await expectStatus(page, 'Saved.', false);
  // The save clears the entry for the next one, and unticks the person it used.
  await expect(page.getByLabel('What happened?', { exact: true })).toHaveValue('');
  await expect(page.getByLabel(name, { exact: true })).not.toBeChecked();
});

test('logging out returns to the sign-in page, and the API then refuses the session', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByLabel('Owner passphrase')).toBeVisible();
  await expect(page.getByLabel('What happened?', { exact: true })).toHaveCount(0);

  const related = await page.request.get('/api/related');
  expect(related.status()).toBe(401);
  expect(await related.json()).toEqual({ error: 'unauthorized' });
});

test.describe('a phone-sized screen', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the form fits the width with no horizontal scroll, and a note saves', async ({ page }) => {
    await fakeSpeechRecognition(page);
    await signIn(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);

    for (const control of [
      page.getByLabel('What happened?', { exact: true }),
      page.getByLabel('When', { exact: true }),
      page.getByLabel('Photos', { exact: true }),
      page.getByRole('button', { name: 'Dictate', exact: true }),
      page.getByLabel('Language', { exact: true }),
      page.getByRole('button', { name: SAVE_BUTTON }),
    ]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
    }

    await page.getByLabel('What happened?', { exact: true }).fill(uniqueText('Note on the phone'));
    await page.getByRole('button', { name: SAVE_BUTTON }).click();
    await expectStatus(page, 'Saved.', false);
  });
});

test('an empty first entry is refused before anything is sent', async ({ page }) => {
  await signIn(page);
  const posted: string[] = [];
  page.on('request', (request) => { if (request.url().endsWith('/api/entries')) posted.push(request.method()); });
  await page.getByRole('button', { name: SAVE_BUTTON }).click();
  await expectStatus(page, 'Write a few words about the moment first.', true);
  await expect(page.getByLabel('What happened?', { exact: true })).toBeFocused();
  expect(posted).toEqual([]);
});

test('a related list that fails to load says so', async ({ page }) => {
  await page.route('**/api/related', (route) => route.fulfill({ status: 500, body: '' }));
  await signIn(page);
  await expect(page.locator('#related-list')).toHaveText('Could not load people and places. Request failed (HTTP 500).');
});

test('with no people or places saved, the related list says so', async ({ page }) => {
  await page.route('**/api/related', (route) => route.fulfill({ json: { items: [], nextAfterId: null } }));
  await signIn(page);
  await expect(page.locator('#related-list')).toHaveText('No people or places saved yet.');
});

test('a photo that fails to upload stays waiting, and the save says so', async ({ page }) => {
  const text = uniqueText('Photo that fails');
  await signIn(page);
  await page.route('**/api/media', (route) => route.abort());
  await page.getByLabel('Photos', { exact: true }).setInputFiles(EXIF_PHOTO);
  await page.getByLabel('What happened?', { exact: true }).fill(text);
  await page.getByRole('button', { name: SAVE_BUTTON }).click();
  await expectStatus(page, 'The entry is saved, but 1 photo(s) did not upload. Press Retry photos to try them again.', true);
  await expect(page.getByRole('button', { name: 'Retry photos' })).toBeEnabled();
  expect(await rowsWithText(text)).toHaveLength(1);
});

test('a file that is not a JPEG leaves the When field at the current time', async ({ page }) => {
  await signIn(page);
  await page.getByLabel('Photos', { exact: true }).setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') });
  await expect(page.getByLabel('When', { exact: true })).toHaveValue(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});

test('a photo the browser cannot decode is saved without previews', async ({ page }) => {
  const text = uniqueText('Phone photo');
  await signIn(page);
  // An HEIC container. The server accepts it by its magic bytes, and Chrome cannot decode it, so the page makes no previews.
  const heic = Buffer.from([0, 0, 0, 0x10, ...Buffer.from('ftypheic'), 0, 0, 0, 0]);
  await page.getByLabel('Photos', { exact: true }).setInputFiles({ name: 'phone.heic', mimeType: 'image/heic', buffer: heic });
  await page.getByLabel('What happened?', { exact: true }).fill(text);
  await page.getByRole('button', { name: SAVE_BUTTON }).click();
  await expectStatus(page, 'Saved.', false);
  await expect(page.locator('#saved-photos figcaption')).toHaveText('Saved without a preview');
  expect(await rowsWithText(text)).toHaveLength(1);
});

test('while a save is in progress the form is locked and says so', async ({ page }) => {
  await signIn(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = () => { resolve(); }; });
  await page.route('**/api/entries', async (route) => {
    await held;
    await route.continue();
  });
  await page.getByLabel('What happened?', { exact: true }).fill(uniqueText('Held save'));
  await page.getByRole('button', { name: SAVE_BUTTON }).click();
  await expectStatus(page, 'Saving…', false);
  await expect(page.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  release();
  await expectStatus(page, 'Saved.', false);
});

test('dictation puts final text at the caret, shows interim text only in the status, and the saved entry has it', async ({ page }) => {
  const base = uniqueText('我们去了公园');
  const expected = base.replace('我们去了公园', '我们中午去了公园');
  await fakeSpeechRecognition(page);
  await signIn(page);
  const dictate = page.getByRole('button', { name: 'Dictate', exact: true });
  await expect(page.locator('#dictate')).toBeVisible();
  await expect(dictate).toHaveAttribute('aria-pressed', 'false');

  await page.getByLabel('Language', { exact: true }).selectOption('zh-CN');
  const entry = page.getByLabel('What happened?', { exact: true });
  await entry.fill(base);
  await entry.evaluate((element: HTMLTextAreaElement) => { element.setSelectionRange(2, 2); });
  await dictate.click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#dictate-status')).toHaveText('Listening…');
  expect(await latestRecognition(page)).toMatchObject({ count: 1, lang: 'zh-CN', continuous: true, interimResults: true, started: 1 });

  await hear(page, [{ isFinal: false, transcript: '中' }]);
  await expect(page.locator('#dictate-status')).toHaveText('中');
  await expect(entry).toHaveValue(base);

  await hear(page, [{ isFinal: true, transcript: '中午' }]);
  await expect(entry).toHaveValue(expected);
  await expect(entry).toHaveJSProperty('selectionStart', 4);
  await expect(page.locator('#dictate-status')).toHaveText('Listening…');

  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  expect((await latestRecognition(page)).stopped).toBe(1);
  await fireHandler(page, 'onend');
  await expect(dictate).toHaveText('Dictate');
  await expect(dictate).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#dictate-status')).toHaveText('');

  await page.getByRole('button', { name: SAVE_BUTTON }).click();
  await expectStatus(page, 'Saved.', false);
  await expect(dictate).toBeEnabled();
  expect(await rowsWithText(expected)).toHaveLength(1);
});

test('a browser without speech recognition keeps the dictation controls hidden', async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  });
  await signIn(page);
  await expect(page.getByLabel('What happened?', { exact: true })).toBeVisible();
  await expect(page.locator('#dictate')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Dictate', exact: true })).toBeHidden();
});

test('a denied microphone is named in the dictation status, and the button resets', async ({ page }) => {
  await fakeSpeechRecognition(page);
  await signIn(page);
  const dictate = page.getByRole('button', { name: 'Dictate', exact: true });
  await dictate.click();
  await fireHandler(page, 'onerror', { error: 'not-allowed' });
  await fireHandler(page, 'onend');
  await expect(page.locator('#dictate-status')).toHaveText('Microphone access was denied.');
  await expect(page.locator('#dictate-status')).toHaveClass('error');
  await expect(dictate).toHaveText('Dictate');
  await expect(dictate).toHaveAttribute('aria-pressed', 'false');
});

test('saving stops a running dictation, and the Dictate button and language stay locked until the save ends', async ({ page }) => {
  await fakeSpeechRecognition(page);
  await signIn(page);
  const dictate = page.getByRole('button', { name: 'Dictate', exact: true });
  const language = page.getByLabel('Language', { exact: true });
  await dictate.click();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = () => { resolve(); }; });
  await page.route('**/api/entries', async (route) => {
    await held;
    await route.continue();
  });
  await page.getByLabel('What happened?', { exact: true }).fill(uniqueText('Spoken while saving'));
  await page.getByRole('button', { name: SAVE_BUTTON }).click();
  await expect.poll(async () => (await latestRecognition(page)).stopped).toBe(1);
  await fireHandler(page, 'onend');
  await expect(dictate).toBeDisabled();
  await expect(language).toBeDisabled();
  release();
  await expectStatus(page, 'Saved.', false);
  await expect(dictate).toBeEnabled();
  await expect(language).toBeEnabled();
});

test('the dictation language is remembered across reloads', async ({ page }) => {
  await fakeSpeechRecognition(page);
  await signIn(page);
  await page.getByLabel('Language', { exact: true }).selectOption('zh-CN');
  await page.reload();
  await expect(page.getByLabel('Language', { exact: true })).toHaveValue('zh-CN');
});
