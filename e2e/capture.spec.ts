import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { query, seedPersonRow, sqlString } from './support/d1.ts';
import { expect, test } from './support/fixtures.ts';
import { jpegSize } from './support/jpeg.ts';
import { EXIF_PHOTO } from './support/paths.ts';

// TEST ONLY. This passphrase is public. Its verifier is in e2e/e2e.env, and the owner's real passphrase and verifier
// are never read or used by these tests.
const OWNER_PASSPHRASE = 'memem-e2e-TEST-ONLY-passphrase-not-a-secret';
const SAVE_BUTTON = 'Save entry';
const UNREACHABLE = 'Could not reach MeMem. Check the connection; what you typed is still here.';

/** A note text that no other test or run uses, so its rows can be counted exactly. */
function uniqueText(label: string): string {
  return `${label} ${randomUUID()}`;
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/capture');
  await page.getByLabel('Owner passphrase').fill(OWNER_PASSPHRASE);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByLabel('What happened?', { exact: true })).toBeVisible();
}

function rowsWithText(text: string) {
  return query<{ id: string; occurred_at: string | null }>(`SELECT id, occurred_at FROM memories WHERE owner = 'owner' AND search_text = ${sqlString(text.toLowerCase())}`);
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
  await expect(page.getByRole('status')).toHaveText('Saved.');

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
  await expect(page.getByRole('status')).toHaveText(UNREACHABLE);

  await page.getByRole('button', { name: SAVE_BUTTON }).click();
  await expect(page.getByRole('status')).toHaveText('Saved.');
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
  await expect(page.getByRole('status')).toHaveText('Saved.');
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
    await signIn(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);

    for (const control of [
      page.getByLabel('What happened?', { exact: true }),
      page.getByLabel('When', { exact: true }),
      page.getByLabel('Photos', { exact: true }),
      page.getByRole('button', { name: SAVE_BUTTON }),
    ]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
    }

    await page.getByLabel('What happened?', { exact: true }).fill(uniqueText('Note on the phone'));
    await page.getByRole('button', { name: SAVE_BUTTON }).click();
    await expect(page.getByRole('status')).toHaveText('Saved.');
  });
});
