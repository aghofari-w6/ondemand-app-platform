import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** WCAG 2.1 AA check of the current page. */
export async function expectAccessible(page: Page, name: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
  expect(summary, `axe violations on ${name}`).toEqual([]);
}

export async function signUp(page: Page, name: string) {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`;
  await page.goto('/signup');
  await page.getByLabel('Business name').fill(name);
  await page.getByLabel('Workspace address').fill(slug);
  await page.getByLabel('Your name').fill('Jamie Owner');
  await page.getByLabel('Work email').fill(`jamie@${slug}.example`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Open sign-in link' }).click();
  await expect(page.getByRole('heading', { name: `Hello, ${name}` })).toBeVisible();
  return slug;
}

/** Picks an option in a React Aria Select by its label. */
export async function choose(page: Page, label: string | RegExp, option: string) {
  await page.getByRole('button', { name: typeof label === 'string' ? new RegExp(`(^|\\s)${label}( \\*)?$`) : label }).first().click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

export const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
