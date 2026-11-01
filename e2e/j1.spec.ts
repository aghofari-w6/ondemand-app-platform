import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './helpers.ts';

async function provision(page: Page, app: string) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Catalog' }).click();
  await expect(page.getByRole('heading', { name: 'Catalog', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: `Provision ${app}` }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`Provisioning ${app}`, 'i') })).toBeVisible();
  await expect(page.getByText(`${app.toLowerCase()} is active.`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('list', { name: 'Steps' }).getByRole('listitem')).toHaveCount(8);
}

test('J1: sign up → provision Ordering and POS → offline POS sale → appears in Ordering', async ({ page, context }) => {
  const slug = `j1-${Date.now().toString(36)}`;

  // Sign up: tenant + Owner in one transaction; the magic link is shown on screen (demo mode).
  await page.goto('/signup');
  await expect(page.getByRole('heading', { name: 'Create your workspace' })).toBeVisible();
  await expectAccessible(page, 'signup');
  await page.getByLabel('Business name').fill('J1 Coffee');
  await page.getByLabel('Workspace address').fill(slug);
  await page.getByLabel('Your name').fill('Jamie Owner');
  await page.getByLabel('Work email').fill(`jamie@${slug}.example`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Open sign-in link' }).click();

  // Hello tenant + onboarding checklist, read under RLS.
  await expect(page.getByRole('heading', { name: 'Hello, J1 Coffee' })).toBeVisible();
  await expect(page.getByText('Get started (1 of 5)')).toBeVisible();

  // Catalog + provisioning saga with the live checklist.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Catalog' }).click();
  await expectAccessible(page, 'catalog');
  await provision(page, 'Ordering');
  await expectAccessible(page, 'provisioning');
  await provision(page, 'POS');

  // POS: open a shift, then ring up a sale while offline.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'POS' }).click();
  await page.getByRole('button', { name: 'Open shift' }).click();
  await expect(page.getByRole('button', { name: 'Add Caffè latte' })).toBeVisible();

  await context.setOffline(true);
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add Caffè latte' }).click();
  await page.getByRole('button', { name: 'Add Caffè latte' }).click();
  await page.getByRole('button', { name: 'Add Butter croissant' }).click();
  await expect(page.getByTestId('cart-total')).toContainText('104');
  await page.getByRole('button', { name: /^Charge/ }).click();
  await expect(page.getByText(/saved on this device and will sync/)).toBeVisible();
  await expect(page.getByTestId('queue-count')).toHaveText('1 sale waiting to sync');

  // Reconnect: the queued sale syncs with its idempotency key and original sale time.
  await context.setOffline(false);
  await expect(page.getByText('Synced 1 offline sale.')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('queue-count')).toHaveText('0 sales waiting to sync');

  // Ordering's operational view shows the POS sale as an order (via the event bus).
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Ordering' }).click();
  await page.getByRole('button', { name: 'POS sales' }).click();
  const table = page.getByRole('table', { name: 'Orders' });
  await expect(async () => {
    await page.getByRole('button', { name: 'All orders' }).click();
    await page.getByRole('button', { name: 'POS sales' }).click();
    await expect(table.getByRole('row')).toHaveCount(2, { timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  const row = table.getByRole('row').nth(1);
  await expect(row).toContainText('pos');
  await expect(row).toContainText('completed');
  await expect(row).toContainText('Main store');
  await expect(row).toContainText('104');
  await expectAccessible(page, 'ordering workspace');

  // Detail shows the order's events, caused by the POS sale.
  await row.getByRole('link').click();
  await expect(page.getByRole('heading', { name: /^Order \d+$/ })).toBeVisible();
  await expect(page.getByText('order.created')).toBeVisible();
});
