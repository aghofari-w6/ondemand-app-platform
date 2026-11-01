import { createServer, type IncomingMessage, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { choose, expectAccessible, nav, signUp } from './helpers.ts';

/** Webhook receiver for the Integration Hub part of the journey. */
let server: Server;
let port = 0;
let status = 200;
const hits: { headers: IncomingMessage['headers']; body: string }[] = [];

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ headers: req.headers, body });
      res.writeHead(status, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

test('Phase 2: Data studio → custom records → Integration Hub → API access', async ({ page }) => {
  test.setTimeout(120_000);
  await signUp(page, 'Studio Coffee');

  // Data studio: a custom entity with a select, a number, a formula and a rule; a board layout.
  await nav(page, 'Data studio');
  await expect(page.getByRole('heading', { name: 'Data studio', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Start a draft' }).click();
  await page.getByLabel('Entity name').fill('Supplier');
  await page.getByLabel('Title field label').fill('Name');
  await page.getByRole('button', { name: 'Add entity' }).click();
  await expect(page.getByRole('heading', { name: 'Supplier (supplier)' })).toBeVisible();

  const addField = async (label: string, type: string, extra?: () => Promise<void>) => {
    await page.getByLabel('Field label', { exact: true }).fill(label);
    if (type !== 'text') await choose(page, 'Type', type);
    if (extra) await extra();
    await page.getByRole('button', { name: 'Add field' }).click();
    await expect(page.getByRole('cell', { name: new RegExp(`^${label}`) })).toBeVisible();
  };
  await addField('Tier', 'select', () => page.getByLabel('Options (comma separated)').fill('gold, silver'));
  await addField('Discount', 'number');
  await addField('Display', 'text', () => page.getByLabel('Formula (makes it computed)').fill('upper(name)'));
  await page.getByLabel('Rule name').fill('Discount cap');
  await page.getByLabel('Applies when (optional)').fill('discount != null');
  await page.getByLabel('Must be true').fill('discount <= 30');
  await page.getByLabel('Error message').fill('Discount cannot exceed 30%');
  await page.getByRole('button', { name: 'Add rule' }).click();
  await expect(page.getByText('Rule “Discount cap”')).toBeVisible();

  await page.getByRole('button', { name: 'Layouts' }).click();
  await choose(page, 'Kind', 'board');
  await page.getByLabel('Group by (a select field)').fill('tier');
  await page.getByLabel('Card fields (comma separated)').fill('discount');
  await page.getByRole('button', { name: 'Add layout' }).click();
  await expect(page.getByText('board · custom:supplier')).toBeVisible();
  await expectAccessible(page, 'data studio');

  await page.getByRole('button', { name: 'Review and publish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review and publish' });
  await expect(dialog.getByText('custom:supplier: entity added')).toBeVisible();
  await dialog.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/Published version 1/)).toBeVisible();

  // Custom records: the rule rejects, the formula computes, the board groups.
  await page.getByRole('link', { name: 'Open Supplier records' }).click();
  await page.getByRole('button', { name: 'New supplier' }).click();
  const form = page.getByRole('dialog', { name: 'New supplier' });
  await form.getByLabel('Name *').fill('Kopi Nusantara');
  await choose(page, 'Tier', 'gold');
  await form.getByLabel('Discount', { exact: true }).fill('45');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByText('Discount cannot exceed 30%')).toBeVisible();
  await form.getByLabel('Discount', { exact: true }).fill('10');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Kopi Nusantara' })).toBeVisible();
  await expect(page.getByText('KOPI NUSANTARA', { exact: true })).toBeVisible();
  await expectAccessible(page, 'record detail');
  await page.getByRole('link', { name: 'Supplier', exact: true }).click();
  await page.getByRole('button', { name: 'Board' }).click();
  await expect(page.getByRole('listitem', { name: 'Gold: 1' })).toBeVisible();
  await expectAccessible(page, 'records board');

  // Integration Hub: a signed webhook for new records.
  await nav(page, 'Integration Hub');
  await expectAccessible(page, 'integration hub');
  await page.getByRole('button', { name: 'New endpoint' }).click();
  const ep = page.getByRole('dialog', { name: 'New endpoint' });
  await ep.getByLabel('Name', { exact: true }).fill('ERP webhook');
  await ep.getByLabel('Event types (comma separated)').fill('record.created');
  await ep.getByLabel('URL').fill(`http://127.0.0.1:${port}/hook`);
  await ep.getByRole('button', { name: 'Create endpoint' }).click();
  await expect(page.getByTestId('signing-secret')).toContainText('whsec_');

  const createSupplier = (name: string) => page.request.post('/api/data/supplier', { data: { values: { name } } });
  expect((await createSupplier('Teh Jawa')).status()).toBe(201);
  await expect.poll(() => hits.length, { timeout: 15_000 }).toBe(1);
  expect(hits[0]!.headers['webhook-signature']).toMatch(/^v1,/);
  expect(JSON.parse(hits[0]!.body).data.values.name).toBe('Teh Jawa');

  // Failure → dead letter → replay with the same event id.
  await page.getByRole('link', { name: 'ERP webhook' }).click();
  await expect(page.getByRole('heading', { name: 'ERP webhook' })).toBeVisible();
  status = 500;
  expect((await createSupplier('Gula Aren')).status()).toBe(201);
  await choose(page, 'Show', 'dead');
  await expect(page.getByRole('list', { name: 'Deliveries' }).getByText('dead')).toBeVisible({ timeout: 20_000 });
  const deadId = hits.at(-1)!.headers['webhook-id'];
  await expectAccessible(page, 'endpoint delivery log');
  status = 200;
  await page.getByRole('button', { name: 'Replay all dead' }).click();
  await expect.poll(() => hits.filter((h) => h.headers['webhook-id'] === deadId && h.body.includes('Gula Aren')).length, { timeout: 15_000 }).toBe(3);
  await choose(page, 'Show', 'succeeded');
  await expect(page.getByText('replayed 1×')).toBeVisible();

  // API access: a read-only key reads records through /v1.
  await nav(page, 'Integration Hub');
  await page.getByRole('button', { name: 'API access' }).click();
  await page.getByLabel('Name', { exact: true }).fill('reporting');
  await page.getByRole('button', { name: 'Create API key' }).click();
  const key = (await page.getByTestId('new-credential').textContent())!.trim();
  expect(key).toMatch(/^aod_key\./);
  const res = await page.request.get('/v1/records/supplier', { headers: { authorization: `Bearer ${key}` } });
  expect(res.status()).toBe(200);
  expect((await res.json()).items.map((i: any) => i.values.name).sort()).toEqual(['Gula Aren', 'Kopi Nusantara', 'Teh Jawa']);
  await expectAccessible(page, 'api access');
});
