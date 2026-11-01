import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { choose, expectAccessible, nav, signUp } from './helpers.ts';

/**
 * J4: dashboards with a store filter, a scheduled report and a CSV export, a retention
 * policy anonymising old customer names, and a data subject request that exports and
 * then erases a test customer, with everything audited.
 */

// Test setup only: makes one order "old" for the retention policy (time travel).
const ADMIN_URL = process.env.MIGRATION_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/aod';

async function provision(page: Page, app: string) {
  await nav(page, 'Catalog');
  await page.getByRole('button', { name: `Provision ${app}` }).click();
  await expect(page.getByText(`${app.toLowerCase()} is active.`)).toBeVisible({ timeout: 30_000 });
}

test('J4: dashboards, reports, retention and a data subject request', async ({ page }) => {
  test.setTimeout(240_000);
  await signUp(page, 'Insight Coffee');

  // The Analytics package comes with the Growth plan.
  await nav(page, 'Settings');
  await choose(page, 'Plan', 'Growth (12 slots, all packages)');
  await page.getByRole('button', { name: /Activate with this plan|Change plan/ }).click();
  await expect(page.getByText('Plan updated; the workspace is active.')).toBeVisible();
  await provision(page, 'Ordering');

  const order = async (store: string, total: number, extra: Record<string, unknown> = {}) => {
    const r = await page.request.post('/api/apps/ordering/commands/order.create', { data: { channel: 'web', store, lines: [{ sku: 'K', name: 'Kopi', qty: 1, unit_price: total }], ...extra } });
    expect(r.status()).toBe(201);
    return (await r.json()).id as string;
  };
  await order('Kemang', 100_000);
  await order('Kemang', 50_000);
  await order('Senopati', 70_000);
  const oldOrder = await order('Senopati', 30_000, { customer_name: 'Old Customer', customer_phone: '0811-0000-0001' });
  const testOrder = await order('Kemang', 45_000, { customer_name: 'Tara Test', customer_phone: '0812-7777-0001' });

  // ---- Dashboards: the default dashboard; a store filter updates every widget
  await nav(page, 'Dashboards');
  await expect(page.getByRole('heading', { name: 'Dashboards', level: 1 })).toBeVisible();
  const ordersKpi = page.getByTestId('widget-kpi-ordering-orders').getByTestId('kpi-value');
  const revenueKpi = page.getByTestId('widget-kpi-ordering-revenue').getByTestId('kpi-value');
  await expect(ordersKpi).toHaveText('5', { timeout: 30_000 });
  await expect(revenueKpi).toContainText('295');
  await expect(page.getByTestId('widget-bar-ordering-revenue').getByRole('list')).toContainText('Senopati');
  await expectAccessible(page, 'dashboards');
  await choose(page, 'Store', 'Kemang');
  await expect(ordersKpi).toHaveText('3');
  await expect(revenueKpi).toContainText('195');
  await expect(page.getByTestId('widget-bar-ordering-revenue').getByRole('list')).not.toContainText('Senopati');
  await expect(page.getByTestId('widget-top-stores')).not.toContainText('Senopati');

  // ---- Reports: a scheduled report and a manual CSV export
  await nav(page, 'Reports');
  await page.getByRole('button', { name: 'New report' }).click();
  await page.getByLabel('Report name').fill('Store revenue daily');
  await page.getByRole('dialog').getByRole('checkbox', { name: 'Revenue' }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('dialog').getByRole('checkbox', { name: 'Revenue' })).toBeChecked();
  await choose(page, 'Rows', 'One row per store');
  await choose(page, 'Schedule', 'Every day');
  await page.getByRole('button', { name: 'Save report' }).click();
  await expect(page.getByText(/every day at 06:00 UTC as CSV/)).toBeVisible();
  await expectAccessible(page, 'reports');
  await page.getByRole('button', { name: /^Export CSV\W+Store revenue daily$/ }).click();
  const link = page.getByRole('link', { name: 'Download', exact: true });
  await expect(link).toBeVisible();
  const csv = await (await page.request.get((await link.getAttribute('href'))!)).text();
  expect(csv.split('\r\n')[0]).toBe('Store,Orders,Revenue');
  expect(csv).toContain('Kemang,3,195000');

  // ---- Data governance: PII inventory and access review
  await nav(page, 'Data governance');
  await expect(page.getByRole('cell', { name: 'Order: Customer' })).toBeVisible();
  await expectAccessible(page, 'governance: PII inventory');
  await page.getByRole('button', { name: 'Access review' }).click();
  await expect(page.getByRole('cell', { name: 'Order: Phone' })).toBeVisible();
  await expectAccessible(page, 'governance: access review');

  // ---- Retention: anonymise customer names on orders older than 30 days
  const db = new pg.Client({ connectionString: ADMIN_URL });
  await db.connect();
  try {
    await db.query("UPDATE ord_order SET created_at = now() - interval '90 days' WHERE id = $1", [oldOrder]);
  } finally {
    await db.end();
  }
  await page.getByRole('button', { name: 'Retention' }).click();
  await choose(page, 'Data', 'ordering:order');
  await page.getByLabel('After (days)').fill('30');
  await page.getByRole('button', { name: 'Save policy' }).click();
  await expect(page.getByText(/Policy saved/)).toBeVisible();
  await page.getByRole('button', { name: /^Run now\W+ordering:order$/ }).click();
  await expect(page.getByText('ordering:order: 1 record(s) processed.')).toBeVisible();
  await expectAccessible(page, 'governance: retention');
  const anonymised = await (await page.request.get(`/api/apps/ordering/entities/order/${oldOrder}`)).json();
  expect(JSON.stringify(anonymised)).toContain('[anonymised]');
  expect(JSON.stringify(anonymised)).not.toContain('Old Customer');

  // ---- Data subject request: export, then erase the test customer
  await page.getByRole('button', { name: 'Data subject requests' }).click();
  await page.getByLabel('Email or phone of the person').fill('+62 812 7777 0001');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByText('Found 1 record(s). The export is ready.')).toBeVisible();
  const exported = await (await page.request.get((await page.getByRole('link', { name: 'Download the export', exact: true }).getAttribute('href'))!)).json();
  expect(JSON.stringify(exported)).toContain('Tara Test');
  await expectAccessible(page, 'governance: data subject requests');
  await choose(page, 'Request', 'Erase their data');
  await page.getByLabel('Email or phone of the person').fill('0812-7777-0001');
  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  await expect(page.getByText(/Erased personal data from 1 record\(s\)/)).toBeVisible();
  const erased = await (await page.request.get(`/api/apps/ordering/entities/order/${testOrder}`)).json();
  expect(JSON.stringify(erased)).not.toContain('Tara Test');
  expect(JSON.stringify(erased)).toContain('45000');

  // ---- Audit-log export, and everything is in the audit log
  await page.getByRole('button', { name: 'Audit-log export' }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const auditLink = page.getByRole('link', { name: 'Download CSV' });
  await expect(auditLink).toBeVisible();
  const audit = await (await page.request.get((await auditLink.getAttribute('href'))!)).text();
  for (const action of ['platform:retention.applied', 'platform:dsr.export', 'platform:dsr.erase', 'platform:report.ran']) expect(audit).toContain(action);
  expect(audit).not.toContain('Tara Test');
  await expectAccessible(page, 'governance: audit export');
});
