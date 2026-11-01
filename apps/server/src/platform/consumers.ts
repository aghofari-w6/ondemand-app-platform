import type { EventDraft, EventEnvelope } from '@aod/shared';
import { newId, type Tx } from '../db/database.ts';
import type { Consumer } from '../ports/index.ts';
import { activeApps } from './commands.ts';
import type { Platform } from './context.ts';
import { writeOutbox } from './outbox.ts';

/**
 * Builds event-bus consumers from the manifests' `events.consumes`. A consumer runs
 * for a tenant only while its app is active and its capability rule is satisfied;
 * otherwise the event is left unprocessed ('skipped') for a later backfill.
 */
export function templateConsumers(p: Platform): Consumer[] {
  const out: Consumer[] = [];
  for (const { manifest, template } of p.catalog.apps.values()) {
    const byName = new Map<string, { types: string[]; capability: string | undefined }>();
    for (const c of manifest.events.consumes) {
      const e = byName.get(c.consumer) ?? { types: [], capability: c.capability };
      e.types.push(c.type);
      byName.set(c.consumer, e);
    }
    for (const [name, { types, capability }] of byName) {
      const fn = template.consumers![name]!;
      const published = new Set(manifest.events.publishes.map((e) => e.type));
      out.push({
        name: `${manifest.id}.${name}`,
        types,
        async handle(event: EventEnvelope, tx: Tx) {
          const active = await activeApps(tx);
          if (!active.includes(manifest.id)) return 'skipped';
          if (capability && !p.catalog.activeCapabilities(active).includes(capability)) return 'skipped';
          const installed = await tx.selectFrom('installed_app').select('config').where('app', '=', manifest.id).where('status', '=', 'active').executeTakeFirst();
          const drafts: EventDraft[] = [];
          await p.ports.telemetry.span(`${manifest.id}.consumer`, { 'aod.consumer': name, 'aod.event': event.type }, () =>
            fn(
              {
                tx,
                tenantId: event.tenant_id,
                now: () => new Date(),
                newId,
                config: { ...manifest.config, ...((installed?.config as object) ?? {}) },
                emit(d) {
                  if (!published.has(d.type)) throw new Error(`${manifest.id}.${name} may not emit ${d.type}`);
                  drafts.push(d);
                },
              },
              event,
            ),
          );
          await writeOutbox(tx, drafts, {
            tenantId: event.tenant_id,
            app: manifest.id,
            correlationId: event.correlation_id,
            causationId: event.id,
            traceparent: event.traceparent,
            origin: 'system',
            workflowHop: event.workflow_hop,
            workflowChain: event.workflow_chain,
            newId,
          });
          return undefined;
        },
      });
    }
  }
  return out;
}

/**
 * Replays a tenant's past events through the consumers of `app` (and of apps whose
 * capability just became active). Dedup via processed_event keeps it exactly-once.
 */
export async function backfillTenant(p: Platform, consumers: Consumer[], tenantId: string) {
  for (const c of consumers) {
    let after = 0;
    for (;;) {
      const batch = await p.database.withTenant(tenantId, (tx) =>
        tx.selectFrom('event_log').select(['seq', 'id', 'payload']).where('type', 'in', c.types).where('seq', '>', after).orderBy('seq').limit(200).execute(),
      );
      if (!batch.length) break;
      for (const ev of batch) {
        await p.database.withTenant(tenantId, async (tx) => {
          const fresh = await tx
            .insertInto('processed_event')
            .values({ consumer: c.name, event_id: ev.id, tenant_id: tenantId })
            .onConflict((oc) => oc.columns(['consumer', 'event_id']).doNothing())
            .returning('event_id')
            .executeTakeFirst();
          if (fresh && (await c.handle(ev.payload as EventEnvelope, tx)) === 'skipped') {
            await tx.deleteFrom('processed_event').where('consumer', '=', c.name).where('event_id', '=', ev.id).execute();
          }
        });
        after = Number(ev.seq);
      }
    }
  }
}
