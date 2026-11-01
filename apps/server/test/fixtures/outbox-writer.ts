/**
 * Child process for the outbox crash test: writes business rows + outbox events in
 * one transaction as fast as it can, while running the dispatcher with a sink
 * consumer. The parent SIGKILLs it at an arbitrary moment.
 */
import { newId } from '../../src/db/database.ts';
import { createPlatform } from '../../src/platform/create.ts';
import { writeOutbox } from '../../src/platform/outbox.ts';
import { sinkConsumer } from './sink.ts';

const [tenantA, tenantB] = (process.env.TENANTS ?? '').split(',');
const p = createPlatform({ env: { DATABASE_URL: process.env.APP_URL!, NODE_ENV: 'test', DISPATCH_INTERVAL_MS: '5' }, log: { info() {}, warn() {}, error() {} } });
p.ports.eventBus.subscribe(sinkConsumer);
p.ports.eventBus.start().catch((e: unknown) => {
  console.error('outbox writer: event bus failed to start', e);
  process.exit(1);
});

let n = 0;
for (;;) {
  const tenantId = n % 2 === 0 ? tenantA! : tenantB!;
  const id = newId();
  await p.database.withTenant(tenantId, async (tx) => {
    await tx.insertInto('outbox_test.source').values({ id, tenant_id: tenantId, n }).execute();
    await writeOutbox(tx, [{ type: 'test.written', aggregateType: 'test', aggregateId: id, data: { n } }], { tenantId, app: 'test', correlationId: `crash-${n}`, newId });
  });
  n++;
  process.stdout.write('.');
}
