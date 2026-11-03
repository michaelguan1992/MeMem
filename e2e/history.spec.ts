import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { query, sqlString } from './support/d1.ts';
import { expect, test } from './support/fixtures.ts';
import { distinctJpeg, withoutExif } from './support/jpeg.ts';
import { SAVE_BUTTON, expectLine, expectStatus, rowsWithText, signIn, uniqueText } from './support/owner.ts';
import { BASE_URL, EXIF_PHOTO } from './support/paths.ts';

const CONFLICT = 'This entry was changed elsewhere. Reload to see the latest version.';
const PHOTO_CONFLICT = 'This photo was changed elsewhere. Reload to see the latest version.';
const DELETE_QUESTION = 'Delete this photo permanently? This cannot be undone.';
const REMOVED = 'Photo removed from this entry. It is now under Unlinked photos.';
const ADDED = 'Photo added to this entry.';
const DELETED = 'Photo deleted.';
// The fixture's EXIF time is 2024-05-01 14:30 at +09:00. The server keeps that instant as 05:30 UTC.
const FIXTURE_TAKEN_AT = new Date('2024-05-01T05:30:00.000Z');

/** The list item of the entry with this text. */
function entryItem(page: Page, text: string) {
  return page.getByRole('listitem').filter({ hasText: text });
}

/** The entry being edited. Only one entry is edited at a time, so there is at most one. */
function editorOf(page: Page): Locator {
  return page.locator('li.editing');
}

/** The status line of the open editor's Photos area, which reports the photo changes made in that editor. */
function photoLine(page: Page): Locator {
  return editorOf(page).getByRole('group', { name: 'Photos', exact: true }).getByRole('status');
}

/** The status line of the Unlinked photos section, which reports the changes made there. */
function unlinkedLine(page: Page): Locator {
  return page.getByRole('region', { name: 'Unlinked photos', exact: true }).getByRole('status');
}

/** Saves one entry on the capture page, then opens Past entries and waits until the entry is listed. */
async function saveThenOpenPastEntries(page: Page, text: string, when?: string): Promise<void> {
  await signIn(page);
  await page.getByLabel('What happened?', { exact: true }).fill(text);
  if (when !== undefined) await page.getByLabel('When', { exact: true }).fill(when);
  await page.getByRole('button', { name: SAVE_BUTTON }).click();
  await expectStatus(page, 'Saved.', false);
  await page.getByRole('link', { name: 'Past entries' }).click();
  await expect(page.getByRole('heading', { name: 'Past entries' })).toBeVisible();
  await expect(entryItem(page, text)).toBeVisible();
}

/** Saves one more entry from Past entries: New entry, then the same steps. */
async function saveAnotherEntry(page: Page, text: string): Promise<void> {
  await page.getByRole('link', { name: 'New entry' }).click();
  await page.getByLabel('What happened?', { exact: true }).fill(text);
  await page.getByRole('button', { name: SAVE_BUTTON }).click();
  await expectStatus(page, 'Saved.', false);
  await page.getByRole('link', { name: 'Past entries' }).click();
  await expect(entryItem(page, text)).toBeVisible();
}

/** Opens the editor of the entry with this text. */
async function openEditor(page: Page, text: string): Promise<void> {
  await entryItem(page, text).getByRole('button', { name: 'Edit' }).click();
  await expect(editorOf(page)).toBeVisible();
}

/** How far the page is wider than the window, in pixels. Zero means there is no horizontal scroll. */
function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** The photo ID in a thumbnail URL, such as /api/media/<id>/thumb. */
function photoIdOf(src: string | null): string {
  const id = src?.match(/^\/api\/media\/([^/]+)\/thumb$/)?.[1];
  if (id === undefined) throw new Error(`Not a thumbnail URL: ${src}`);
  return id;
}

/** The selector of one photo's thumbnail. */
function thumbSelector(id: string): string {
  return `img[src="/api/media/${id}/thumb"]`;
}

/** A photo that no other test uses: the bytes given, with a unique comment added, so their hash is new. */
function uniquePhoto(bytes: Uint8Array): { name: string; mimeType: string; buffer: Buffer } {
  return { name: 'walk.jpg', mimeType: 'image/jpeg', buffer: distinctJpeg(bytes, randomUUID()) };
}

/** Chooses one new photo in the open editor, waits until the page shows it as saved and listed, and returns its ID. */
async function addPhoto(page: Page, bytes?: Uint8Array): Promise<string> {
  const source = bytes ?? await readFile(EXIF_PHOTO);
  await page.getByLabel('Add photos', { exact: true }).setInputFiles(uniquePhoto(source));
  await expect(editorOf(page).locator('.upload .status')).toHaveText('Saved');
  const thumb = editorOf(page).locator('.linked-photos img');
  await expect(thumb).toHaveCount(1);
  return photoIdOf(await thumb.getAttribute('src'));
}

/** The photo rows with this ID: one row with its entry's ID, or one with no entry, or none once the photo is deleted. */
function mediaRows(id: string): Promise<Array<{ memory_id: string | null }>> {
  return query<{ memory_id: string | null }>(`SELECT memory_id FROM media WHERE owner = 'owner' AND id = ${sqlString(id)}`);
}

/** The day of an instant in this browser's zone, which is the day the page shows for a photo. */
function localDay(instant: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}`;
}

/** Clicks a button and answers the confirm it opens with `accept`. Returns the question the page asked. */
async function clickAnswering(page: Page, button: Locator, accept: boolean): Promise<string> {
  const asked = new Promise<string>((resolve) => {
    page.once('dialog', async (dialog) => {
      resolve(dialog.message());
      if (accept) await dialog.accept();
      else await dialog.dismiss();
    });
  });
  await button.click();
  return asked;
}

test('an entry saved on the capture page is listed under Past entries, and New entry goes back to the form', async ({ page }) => {
  const text = uniqueText('Market walk');
  await saveThenOpenPastEntries(page, text);
  await expect(entryItem(page, text).getByRole('button', { name: 'Edit' })).toBeEnabled();

  await page.getByRole('link', { name: 'New entry' }).click();
  await expect(page.getByLabel('What happened?', { exact: true })).toBeVisible();
});

test('an edited entry saves its new text and time, and its stored row moves to version 2', async ({ page }) => {
  const text = uniqueText('Ferry ride');
  const edited = uniqueText('Ferry ride, after all');
  await saveThenOpenPastEntries(page, text, '2024-05-01T14:30');

  await entryItem(page, text).getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Entry text', { exact: true }).fill(edited);
  await page.getByLabel('When', { exact: true }).fill('2024-05-02T09:15');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expectStatus(page, 'Saved.', false);
  await expect(entryItem(page, edited)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);

  const rows = await query<{ version: number; occurred_at: string }>(`SELECT version, occurred_at FROM memories WHERE owner = 'owner' AND search_text = ${sqlString(edited.toLowerCase())}`);
  expect(rows).toHaveLength(1);
  expect(rows[0].version).toBe(2);
  // The time was typed in this browser's zone, and the server keeps the same instant in UTC.
  expect(rows[0].occurred_at).toBe(new Date(2024, 4, 2, 9, 15).toISOString());
  expect(await query(`SELECT id FROM memories WHERE owner = 'owner' AND search_text = ${sqlString(text.toLowerCase())}`)).toHaveLength(0);
});

test('an edit against a changed entry is refused, and the typed text stays in the form', async ({ page }) => {
  const text = uniqueText('Stale edit');
  await saveThenOpenPastEntries(page, text);
  await entryItem(page, text).getByRole('button', { name: 'Edit' }).click();

  // Another writer saves the entry first, so the version this editor holds is stale.
  const [row] = await query<{ id: string }>(`SELECT id FROM memories WHERE owner = 'owner' AND search_text = ${sqlString(text.toLowerCase())}`);
  const csrf = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  const changed = await page.request.patch(`/api/entries/${row.id}`, {
    headers: { 'X-CSRF-Token': csrf ?? '', Origin: BASE_URL },
    data: { expectedVersion: 1, text: `${text}, changed elsewhere`, occurredAt: null, relatedIds: [] },
  });
  expect(changed.status()).toBe(200);

  const typed = uniqueText('My own edit');
  await page.getByLabel('Entry text', { exact: true }).fill(typed);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expectStatus(page, CONFLICT, true);
  await expect(page.getByLabel('Entry text', { exact: true })).toHaveValue(typed);
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
});

test('a photo added from the editor is listed on its entry, and its row names that entry', async ({ page }) => {
  const text = uniqueText('Photo walk');
  await saveThenOpenPastEntries(page, text);
  await openEditor(page, text);
  const id = await addPhoto(page);

  const [entry] = await rowsWithText(text);
  expect(await mediaRows(id)).toEqual([{ memory_id: entry.id }]);
  const thumb = editorOf(page).locator(`.linked-photos ${thumbSelector(id)}`);
  await expect.poll(() => thumb.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);

  // Closing the editor shows the entry with the photo, not the strip it had before the photo was added.
  await editorOf(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(entryItem(page, text).locator('.thumbs img')).toHaveCount(1);
});

test('a photo that fails to upload shows its error, and choosing the same photo again uploads it', async ({ page }) => {
  const text = uniqueText('Photo retry');
  await saveThenOpenPastEntries(page, text);
  await openEditor(page, text);
  const photo = uniquePhoto(await readFile(EXIF_PHOTO));
  let failNext = true;
  await page.route('**/api/media', async (route) => {
    if (route.request().method() === 'POST' && failNext) {
      failNext = false;
      await route.abort();
      return;
    }
    await route.continue();
  });

  const input = page.getByLabel('Add photos', { exact: true });
  await input.setInputFiles(photo);
  await expect(editorOf(page).locator('.upload[data-state="failed"] .status')).toHaveText('Could not reach MeMem. Check the connection; what you typed is still here.');
  await input.setInputFiles(photo);
  await expect(editorOf(page).locator('.upload .status')).toHaveText('Saved');
  await expect(editorOf(page).locator('.linked-photos img')).toHaveCount(1);
});

test('a photo whose upload finishes after the editor is closed shows on its entry', async ({ page }) => {
  const text = uniqueText('Photo after cancel');
  await saveThenOpenPastEntries(page, text);
  await openEditor(page, text);

  // The upload request waits until the test releases it, so the editor can be closed while the photo is still uploading.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = () => { resolve(); }; });
  await page.route('**/api/media', async (route) => {
    if (route.request().method() === 'POST') await held;
    await route.continue();
  });
  await page.getByLabel('Add photos', { exact: true }).setInputFiles(uniquePhoto(await readFile(EXIF_PHOTO)));
  await expect(editorOf(page).locator('.upload .status')).toHaveText('Uploading');
  await editorOf(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(entryItem(page, text)).toBeVisible();

  release();
  const thumb = entryItem(page, text).locator('.thumbs img');
  await expect(thumb).toHaveCount(1);
  const [entry] = await rowsWithText(text);
  expect(await mediaRows(photoIdOf(await thumb.getAttribute('src')))).toEqual([{ memory_id: entry.id }]);
});

test('Remove from entry moves the photo to Unlinked photos, shows its day there, and keeps its stored files', async ({ page }) => {
  const text = uniqueText('Photo to unlink');
  await saveThenOpenPastEntries(page, text);
  await openEditor(page, text);
  const id = await addPhoto(page);

  await editorOf(page).locator('.linked-photos').getByRole('button', { name: 'Remove from entry', exact: true }).click();
  await expectLine(photoLine(page), REMOVED, false);
  await expect(editorOf(page).locator('.linked-photos img')).toHaveCount(0);
  const card = page.locator('#unlinked-list .photo-card').filter({ has: page.locator(thumbSelector(id)) });
  await expect(card).toHaveCount(1);
  // The change is reported in the editor's Photos area, and the page's own status line stays as it was.
  await expect(page.locator('#status')).toHaveText('');
  await expect(card.locator('.taken')).toHaveText(localDay(FIXTURE_TAKEN_AT));
  expect(await mediaRows(id)).toEqual([{ memory_id: null }]);
  expect((await page.request.get(`/api/media/${id}/thumb`)).status()).toBe(200);
});

test('an unlinked photo is attached to another entry from its Add from unlinked photos list', async ({ page }) => {
  const from = uniqueText('Photo first entry');
  const to = uniqueText('Photo second entry');
  await saveThenOpenPastEntries(page, from);
  await openEditor(page, from);
  const id = await addPhoto(page);
  await editorOf(page).locator('.linked-photos').getByRole('button', { name: 'Remove from entry', exact: true }).click();
  await expectLine(photoLine(page), REMOVED, false);
  await editorOf(page).getByRole('button', { name: 'Cancel', exact: true }).click();

  await saveAnotherEntry(page, to);
  await openEditor(page, to);
  await editorOf(page).getByRole('button', { name: 'Add from unlinked photos', exact: true }).click();
  const candidate = editorOf(page).locator('.pick .photo-card').filter({ has: page.locator(thumbSelector(id)) });
  await expect(candidate).toHaveCount(1);
  await candidate.getByRole('button', { name: 'Attach', exact: true }).click();
  await expectLine(photoLine(page), ADDED, false);

  await expect(editorOf(page).locator(`.linked-photos ${thumbSelector(id)}`)).toHaveCount(1);
  await expect(candidate).toHaveCount(0);
  await expect(page.locator(`#unlinked-list ${thumbSelector(id)}`)).toHaveCount(0);
  const [target] = await rowsWithText(to);
  expect(await mediaRows(id)).toEqual([{ memory_id: target.id }]);

  await editorOf(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(entryItem(page, to).locator('.thumbs img')).toHaveCount(1);
});

test('Delete permanently asks first: Cancel keeps the photo, and OK removes the row and its files', async ({ page }) => {
  const text = uniqueText('Photo to delete');
  await saveThenOpenPastEntries(page, text);
  await openEditor(page, text);
  const id = await addPhoto(page);
  const [entry] = await rowsWithText(text);
  const deletes: string[] = [];
  page.on('request', (request) => { if (request.method() === 'DELETE') deletes.push(request.url()); });
  const deleteButton = editorOf(page).locator('.linked-photos').getByRole('button', { name: 'Delete permanently', exact: true });

  expect(await clickAnswering(page, deleteButton, false)).toBe(DELETE_QUESTION);
  await expect(editorOf(page).locator(`.linked-photos ${thumbSelector(id)}`)).toHaveCount(1);
  expect(deletes).toEqual([]);
  await expect(photoLine(page)).toHaveText('');
  expect(await mediaRows(id)).toEqual([{ memory_id: entry.id }]);

  const deleted = page.waitForResponse((response) => response.request().method() === 'DELETE' && response.url() === `${BASE_URL}/api/media/${id}`);
  expect(await clickAnswering(page, deleteButton, true)).toBe(DELETE_QUESTION);
  expect((await deleted).status()).toBe(200);
  await expectLine(photoLine(page), DELETED, false);
  await expect(editorOf(page).locator('.linked-photos img')).toHaveCount(0);
  expect(deletes).toEqual([`${BASE_URL}/api/media/${id}`]);
  expect(await mediaRows(id)).toEqual([]);
  expect((await page.request.get(`/api/media/${id}/thumb`)).status()).toBe(404);
});

test('Delete permanently in the Unlinked photos section reports its outcome in that section', async ({ page }) => {
  const text = uniqueText('Photo deleted from the section');
  await saveThenOpenPastEntries(page, text);
  await openEditor(page, text);
  const id = await addPhoto(page);
  await editorOf(page).locator('.linked-photos').getByRole('button', { name: 'Remove from entry', exact: true }).click();
  await expectLine(photoLine(page), REMOVED, false);
  await editorOf(page).getByRole('button', { name: 'Cancel', exact: true }).click();

  const card = page.locator('#unlinked-list .photo-card').filter({ has: page.locator(thumbSelector(id)) });
  await expect(card).toHaveCount(1);
  expect(await clickAnswering(page, card.getByRole('button', { name: 'Delete permanently', exact: true }), true)).toBe(DELETE_QUESTION);
  await expectLine(unlinkedLine(page), DELETED, false);
  await expect(card).toHaveCount(0);
  await expect(page.locator('#status')).toHaveText('');
  expect(await mediaRows(id)).toEqual([]);
});

test('text typed in the editor and not saved survives a photo change', async ({ page }) => {
  const text = uniqueText('Half-written entry');
  await saveThenOpenPastEntries(page, text);
  await openEditor(page, text);
  const typed = uniqueText('Typed but not saved');
  const entryText = editorOf(page).getByLabel('Entry text', { exact: true });
  await entryText.fill(typed);

  await addPhoto(page);
  await expect(entryText).toHaveValue(typed);
  await editorOf(page).locator('.linked-photos').getByRole('button', { name: 'Remove from entry', exact: true }).click();
  await expectLine(photoLine(page), REMOVED, false);
  await expect(entryText).toHaveValue(typed);
  await expect(editorOf(page).getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
});

test('a photo changed elsewhere is refused with its own message, and the list then shows its latest version', async ({ page }) => {
  const text = uniqueText('Photo changed elsewhere');
  await saveThenOpenPastEntries(page, text);
  await openEditor(page, text);
  const id = await addPhoto(page);
  const [entry] = await rowsWithText(text);

  // Another writer changes the photo's caption, so the version this editor holds is stale.
  const csrf = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  const changed = await page.request.patch(`/api/media/${id}`, {
    headers: { 'X-CSRF-Token': csrf ?? '', Origin: BASE_URL },
    data: { expectedVersion: 1, memoryId: entry.id, caption: 'Changed elsewhere' },
  });
  expect(changed.status()).toBe(200);

  const remove = editorOf(page).locator('.linked-photos').getByRole('button', { name: 'Remove from entry', exact: true });
  await remove.click();
  await expectLine(photoLine(page), PHOTO_CONFLICT, true);
  await expect(editorOf(page).locator(`.linked-photos ${thumbSelector(id)}`)).toHaveCount(1);
  await remove.click();
  await expectLine(photoLine(page), REMOVED, false);
  expect(await mediaRows(id)).toEqual([{ memory_id: null }]);
});

test('while a photo change runs, the buttons of that photo are disabled until it ends', async ({ page }) => {
  const text = uniqueText('Photo change in flight');
  await saveThenOpenPastEntries(page, text);
  await openEditor(page, text);
  const id = await addPhoto(page);

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = () => { resolve(); }; });
  await page.route(`**/api/media/${id}`, async (route) => {
    if (route.request().method() === 'PATCH') await held;
    await route.continue();
  });
  const card = editorOf(page).locator('.linked-photos .photo-card');
  await card.getByRole('button', { name: 'Remove from entry', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Remove from entry', exact: true })).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Delete permanently', exact: true })).toBeDisabled();

  release();
  await expectLine(photoLine(page), REMOVED, false);
});

test('with no unlinked photos, the Unlinked section and an entry\'s attach list both say so', async ({ page }) => {
  await page.route((url) => url.pathname === '/api/media' && url.searchParams.get('unlinked') === '1', (route) => route.fulfill({ json: { items: [], nextAfterId: null } }));
  const text = uniqueText('Nothing to attach');
  await saveThenOpenPastEntries(page, text);
  await expect(page.locator('#unlinked-list')).toHaveText('No unlinked photos.');
  await openEditor(page, text);
  await editorOf(page).getByRole('button', { name: 'Add from unlinked photos', exact: true }).click();
  await expect(editorOf(page).locator('.pick')).toHaveText('No unlinked photos.');
});

test('a photo with no capture time is listed under Unlinked photos as Date unknown', async ({ page }) => {
  const text = uniqueText('Photo without a time');
  await saveThenOpenPastEntries(page, text);
  await openEditor(page, text);
  const id = await addPhoto(page, withoutExif(await readFile(EXIF_PHOTO)));
  await editorOf(page).locator('.linked-photos').getByRole('button', { name: 'Remove from entry', exact: true }).click();
  await expectLine(photoLine(page), REMOVED, false);
  const card = page.locator('#unlinked-list .photo-card').filter({ has: page.locator(thumbSelector(id)) });
  await expect(card.locator('.taken')).toHaveText('Date unknown');
});

test.describe('a phone-sized screen', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('Past entries fits the width with no horizontal scroll, even with a long word and the editor open', async ({ page }) => {
    const text = `${uniqueText('Long word')} ${'Supercalifragilisticexpialidocious'.repeat(8)}`;
    await saveThenOpenPastEntries(page, text);
    expect(await horizontalOverflow(page)).toBe(0);

    await entryItem(page, text).getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByLabel('Entry text', { exact: true })).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('the editor with a photo, its Add from unlinked photos list and the Unlinked section fit the width', async ({ page }) => {
    const text = `${uniqueText('Phone photos')} ${'Supercalifragilisticexpialidocious'.repeat(8)}`;
    await saveThenOpenPastEntries(page, text);
    await openEditor(page, text);
    const id = await addPhoto(page);
    await editorOf(page).locator('.linked-photos').getByRole('button', { name: 'Remove from entry', exact: true }).click();
    await expectLine(photoLine(page), REMOVED, false);
    await editorOf(page).getByRole('button', { name: 'Add from unlinked photos', exact: true }).click();
    await expect(editorOf(page).locator(`.pick ${thumbSelector(id)}`)).toHaveCount(1);
    await expect(page.locator(`#unlinked-list ${thumbSelector(id)}`)).toHaveCount(1);
    expect(await horizontalOverflow(page)).toBe(0);
  });
});
