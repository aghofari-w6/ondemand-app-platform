import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { choose, expectAccessible, nav, signUp } from './helpers.ts';

/**
 * J3: a Manager builds, on the canvas, "When a POS sale over Rp 1,000,000 is voided →
 * approval by a manager → approved: refund the payment and notify the store;
 * rejected: notify the cashier". The rejected branch is added in the outline view with
 * the keyboard only.
 */

async function provision(page: Page, app: string) {
  await nav(page, 'Catalog');
  await page.getByRole('button', { name: `Provision ${app}` }).click();
  await expect(page.getByText(`${app.toLowerCase()} is active.`)).toBeVisible({ timeout: 30_000 });
}

async function bigCardSaleVoided(request: APIRequestContext, registerId: string) {
  const id = randomUUID();
  const sale = await request.post('/api/apps/pos/commands/sale.complete', { data: { id, register_id: registerId, lines: [{ sku: 'HMP', name: 'Gift hamper', qty: 3, unit_price: 450000 }], tender: 'card', sold_at: new Date().toISOString() } });
  expect(sale.status()).toBe(201);
  // Let the card tender be captured by Payments (event bus) before voiding.
  await expect(async () => {
    const pays = await (await request.get('/api/apps/payments/entities/payment')).json();
    expect(JSON.stringify(pays)).toContain(`pos:sale:${id}`);
  }).toPass({ timeout: 15_000 });
  const v = await request.post('/api/apps/pos/commands/sale.void', { data: { id, version: (await sale.json()).version, reason: 'wrong hamper' } });
  expect(v.status()).toBe(200);
  return id;
}

/** Keyboard only: focus, open the select, type the option, confirm. */
async function keyboardChoose(page: Page, label: RegExp, option: string) {
  const button = page.getByRole('button', { name: label }).first();
  await button.focus();
  await page.keyboard.press('Enter');
  const opt = page.getByRole('option', { name: option, exact: true });
  await expect(opt).toBeVisible();
  const focused = () => opt.evaluate((el) => el === document.activeElement || el.contains(document.activeElement));
  await page.keyboard.type(option); // typeahead
  for (let i = 0; i < 40 && !(await focused()); i++) await page.keyboard.press('ArrowDown');
  expect(await focused()).toBe(true);
  await page.keyboard.press('Enter');
}

test('J3: build an approval-gated refund on the canvas, test it, run it, approve it, trace it', async ({ page, browser }) => {
  test.setTimeout(240_000);
  await signUp(page, 'Void Coffee');
  await provision(page, 'Payments');
  await provision(page, 'POS');

  // A second manager who will approve.
  await nav(page, 'Users and roles');
  await page.getByRole('button', { name: 'Invite people' }).click();
  await page.getByLabel('Email').fill('budi@void.example');
  await page.getByLabel('Name').fill('Budi Manager');
  await page.getByRole('dialog').getByRole('button', { name: /Role$/ }).click();
  await page.getByRole('option', { name: 'Manager', exact: true }).click();
  await page.getByRole('button', { name: 'Send invitation' }).click();
  const inviteLink = await page.getByRole('link', { name: 'Invitation link' }).getAttribute('href');

  // POS: open a shift; a past void exists before the workflow is built (for the test run).
  await nav(page, 'POS');
  await page.getByRole('button', { name: 'Open shift' }).click();
  await expect(page.getByRole('button', { name: 'Add Caffè latte' })).toBeVisible();
  const registerId = ((await (await page.request.get('/api/apps/pos/queries/registers')).json()).registers[0].id) as string;
  await bigCardSaleVoided(page.request, registerId);

  // ---- Build on the canvas
  await nav(page, 'Workflows');
  await expect(page.getByRole('heading', { name: 'Workflows', level: 1 })).toBeVisible();
  await expectAccessible(page, 'workflows list');
  await page.getByRole('button', { name: 'New workflow' }).click();
  await page.getByLabel('Name').fill('Large void refund');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'Large void refund', level: 1 })).toBeVisible();

  const canvas = page.getByRole('region', { name: 'Workflow canvas' });
  const nodeOn = (name: string) => canvas.locator('.react-flow__node').filter({ hasText: name });
  await nodeOn('When').click();
  await choose(page, 'When this event happens', 'sale.voided (pos)');
  await page.getByLabel('Only if (filter)').fill('trigger.data.total > 1000000');
  await page.getByLabel('Name').fill('Large void');

  // Palette adds after the selected node (its first output).
  await page.getByRole('group', { name: 'Add a node' }).getByRole('button', { name: 'Approval' }).click();
  await page.getByLabel('Title').fill('Refund voided sale {{ trigger.data.receipt_no }}');
  await page.getByLabel('Details shown to approvers').fill('Total {{ trigger.data.total }}, reason: {{ trigger.data.reason }}');
  await page.getByLabel('Name').fill('Manager approval');

  await page.getByRole('group', { name: 'Add a node' }).getByRole('button', { name: 'App command' }).click(); // after "approved"
  await choose(page, 'Command to run', 'payments: payment.refund_by_reference');
  await page.getByLabel('reference (required)').fill('pos:sale:{{ trigger.data.sale_id }}');
  await page.getByLabel('reason', { exact: true }).fill('voided: {{ trigger.data.reason }}');
  await page.getByLabel('Name').fill('Refund payment');

  await page.getByRole('group', { name: 'Add a node' }).getByRole('button', { name: 'Notify' }).click();
  await page.getByLabel('Subject').fill('Refund issued for {{ trigger.data.receipt_no }}');
  await page.getByLabel('Message').fill('Refunded {{ steps.command_1.output.refunded }}.');
  await page.getByLabel('Name').fill('Notify store');
  await expect(nodeOn('Notify store')).toBeVisible();
  await page.getByRole('button', { name: 'Auto-layout' }).click();
  await expectAccessible(page, 'workflow canvas');
  // Every port has a 44 px pointer target (canvas units = screen px at 100% zoom), and
  // ports are at least 44 px apart, so neighbouring targets never overlap.
  const ports = await nodeOn('Manager approval').evaluate((node) => {
    const handles = [...node.querySelectorAll('.react-flow__handle.source')] as HTMLElement[];
    const target = getComputedStyle(handles[0]!, '::before');
    const tops = handles.map((h) => h.parentElement!.offsetTop + h.offsetTop);
    return { width: target.width, height: target.height, gaps: tops.slice(1).map((t, i) => t - tops[i]!) };
  });
  expect(ports.width).toBe('44px');
  expect(ports.height).toBe('44px');
  expect(ports.gaps.every((g) => g >= 44)).toBe(true);

  // ---- Rejected branch in the outline view, keyboard only
  await page.getByRole('button', { name: 'Outline (keyboard)' }).focus();
  await page.keyboard.press('Enter');
  const outline = page.getByRole('region', { name: 'Workflow outline' });
  await expect(outline).toBeVisible();
  await keyboardChoose(page, /New node type$/, 'Notify');
  await keyboardChoose(page, /Connect it after$/, 'Manager approval → rejected');
  await outline.getByRole('button', { name: 'Add node' }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Name').focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Notify cashier');
  await page.getByLabel('Subject').focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Void refund rejected');
  await page.getByRole('checkbox', { name: 'Manager' }).focus();
  await page.keyboard.press('Space'); // untick Manager
  await page.getByRole('checkbox', { name: 'Staff' }).focus();
  await page.keyboard.press('Space');
  await expect(outline.getByRole('button', { name: /Manager approval: output “rejected” goes to/ })).toContainText('Notify cashier');
  await expectAccessible(page, 'workflow outline');

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText(/Draft v1 saved\.$/)).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Problems/ })).toHaveCount(0);

  // ---- Test run on the past void: every node's input and output
  await page.getByRole('button', { name: /Run against$/ }).click();
  await page.getByRole('option', { name: /^sale\.voided · / }).first().click();
  await page.getByRole('button', { name: 'Run test' }).click();
  await expect(page.getByText('Path: trigger → approval_1 → command_1 → notify_1')).toBeVisible();
  await page.getByText('Input and output').nth(2).click();
  await expect(page.getByText('"would_run": "payments/payment.refund_by_reference"')).toBeVisible();
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await expect(nodeOn('Refund payment')).toContainText('succeeded → out');

  // ---- Publish as Manager
  await page.getByRole('button', { name: 'Publish…' }).click();
  await choose(page, 'Run as role', 'Manager');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText(/Published v1\. It runs as Manager\./)).toBeVisible();

  // ---- A real void starts a run that pauses at Approvals
  const saleId = await bigCardSaleVoided(page.request, registerId);
  await expect(async () => {
    const runs = (await (await page.request.get('/api/workflow-runs')).json()).runs;
    expect(runs[0]?.status).toBe('running');
  }).toPass({ timeout: 20_000 });

  // ---- The second manager approves
  const manager = await browser.newContext({ reducedMotion: 'reduce' });
  const mpage = await manager.newPage();
  await mpage.goto(inviteLink!);
  await expect(mpage.getByRole('heading', { name: /Hello, Void Coffee/ })).toBeVisible();
  await nav(mpage, 'Approvals');
  await expect(mpage.getByRole('heading', { name: /^Refund voided sale/ })).toBeVisible();
  await expectAccessible(mpage, 'approvals');
  await mpage.getByLabel(/^Comment on/).fill('Receipt checked');
  await mpage.getByRole('button', { name: 'Approve' }).click();
  await expect(mpage.getByText(/: request approved\.$/)).toBeVisible();
  await manager.close();

  // ---- Refund ran, notification recorded; the execution view shows the path
  await expect(async () => {
    const runs = (await (await page.request.get('/api/workflow-runs')).json()).runs;
    expect(runs[0]?.status).toBe('succeeded');
  }).toPass({ timeout: 20_000 });
  const payments = await (await page.request.get('/api/apps/payments/entities/payment')).json();
  expect(JSON.stringify(payments)).toMatch(new RegExp(`pos:sale:${saleId}[^}]*refunded|refunded[^}]*pos:sale:${saleId}`));

  await nav(page, 'Workflows');
  await page.getByRole('link', { name: 'Large void refund' }).click();
  await page.getByRole('link', { name: /succeeded/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Run of Large void refund' })).toBeVisible();
  const exec = page.getByRole('region', { name: 'Execution path' });
  await expect(exec.locator('.react-flow__node').filter({ hasText: 'Manager approval' })).toContainText('succeeded → approved');
  await expect(exec.locator('.react-flow__node').filter({ hasText: 'Notify store' })).toContainText('succeeded → out');
  await expect(exec.locator('.react-flow__node').filter({ hasText: 'Notify cashier' })).not.toContainText('succeeded');
  await expectAccessible(page, 'execution view');

  // ---- The Trace viewer shows the whole chain from one correlation id
  await page.getByRole('link', { name: 'Open in Trace viewer' }).click();
  const timeline = page.getByRole('list', { name: 'Trace timeline' });
  await expect(timeline).toContainText('sale.voided');
  await expect(timeline).toContainText('Workflow: Large void refund');
  await expect(timeline).toContainText('Budi Manager approved');
  await expect(timeline).toContainText('payment.refunded');
  await expect(timeline).toContainText('platform:workflow.notified');
  await expectAccessible(page, 'trace viewer');
});
