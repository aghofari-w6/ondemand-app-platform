import type { Consumer } from '../../src/ports/index.ts';

/** Records every delivery (no unique constraint, so duplicates would show). */
export const sinkConsumer: Consumer = {
  name: 'test.sink',
  types: ['test.written'],
  async handle(ev, tx) {
    await tx.insertInto('outbox_test.sink').values({ event_id: ev.id, tenant_id: ev.tenant_id }).execute();
  },
};

export const SINK_SCHEMA = `
  DROP SCHEMA IF EXISTS outbox_test CASCADE;
  CREATE SCHEMA outbox_test;
  CREATE TABLE outbox_test.source (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, n integer NOT NULL);
  CREATE TABLE outbox_test.sink (id bigserial PRIMARY KEY, tenant_id uuid NOT NULL, event_id uuid NOT NULL);
  SELECT aod_enable_tenant_rls('outbox_test.source');
  SELECT aod_enable_tenant_rls('outbox_test.sink');
  GRANT USAGE ON SCHEMA outbox_test TO aod_app;
  GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA outbox_test TO aod_app;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA outbox_test TO aod_app;
`;
