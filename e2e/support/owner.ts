import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import { query, sqlString } from './d1.ts';

// TEST ONLY. This passphrase is public. Its verifier is in e2e/e2e.env, and the owner's real passphrase and verifier
// are never read or used by these tests.
export const OWNER_PASSPHRASE = 'memem-e2e-TEST-ONLY-passphrase-not-a-secret';
export const SAVE_BUTTON = 'Save entry';

/** A note text that no other test or run uses, so its rows can be counted exactly. */
export function uniqueText(label: string): string {
  return `${label} ${randomUUID()}`;
}

/** Opens the capture page and signs in with the test passphrase. */
export async function signIn(page: Page): Promise<void> {
  await page.goto('/capture');
  await page.getByLabel('Owner passphrase').fill(OWNER_PASSPHRASE);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByLabel('What happened?', { exact: true })).toBeVisible();
}

/** The owner's rows whose text matches, compared the way the search column stores it: lower-cased. */
export function rowsWithText(text: string): Promise<Array<{ id: string; occurred_at: string | null }>> {
  return query<{ id: string; occurred_at: string | null }>(`SELECT id, occurred_at FROM memories WHERE owner = 'owner' AND search_text = ${sqlString(text.toLowerCase())}`);
}

/** The page's own status line, which entry saves and entry loads report on, shows this text. It is an error only when `error` is set. */
export async function expectStatus(page: Page, text: string, error: boolean): Promise<void> {
  await expectLine(page.locator('#status'), text, error);
}

/** A status line shows this text, and it is styled as an error only when `error` is set. The locator scopes it to its own area. */
export async function expectLine(line: Locator, text: string, error: boolean): Promise<void> {
  await expect(line).toHaveText(text);
  if (error) await expect(line).toHaveClass(/\berror\b/);
  else await expect(line).not.toHaveClass(/\berror\b/);
}
