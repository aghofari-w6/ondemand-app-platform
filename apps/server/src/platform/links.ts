import { action, authorize, customResource, type EventEnvelope, type Principal } from '@aod/shared';
import { sql } from 'kysely';
import type { Tx } from '../db/database.ts';
import type { Consumer } from '../ports/index.ts';
import type { Platform } from './context.ts';
import { publishedDefinition } from './datastudio.ts';
import { decryptDefined } from './fields.ts';
import { hiddenForPrincipal } from './records.ts';
import { readPermission } from './workspace.ts';

/**
 * Link index: relations between records of different apps, recorded from events as
 * declared in each manifest's `links` (apps never hold foreign keys to each other).
 * Custom record link fields write their links synchronously (records.ts).
 */

const pick = (env: EventEnvelope, path: string): string | null => {
  let cur: unknown = env;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, seg)) return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return typeof cur === 'string' || typeof cur === 'number' ? String(cur) : null;
};

export function linkIndexConsumer(p: Platform): Consumer {
  const decls = p.catalog.manifests().flatMap((m) => m.links.map((l) => ({ ...l, app: m.id })));
  return {
    name: 'platform.link_index',
    types: [...new Set(decls.map((d) => d.on))],
    async handle(event, tx) {
      for (const d of decls.filter((x) => x.on === event.type && x.app === event.app)) {
        const from = pick(event, d.from.id);
        const to = pick(event, d.to.id);
        if (!from || !to) continue;
        await tx
          .insertInto('record_link')
          .values({ tenant_id: event.tenant_id, from_type: d.from.resource, from_id: from, rel: d.rel, to_type: d.to.resource, to_id: to, source_event: event.id })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    },
  };
}

interface Resolved {
  app: string;
  entity: string;
  label: string;
  title: string | null;
  path: string | null;
}

async function resolve(p: Platform, tx: Tx, principal: Principal, type: string, id: string): Promise<Resolved | null> {
  if (type.startsWith('custom::')) {
    const { definition } = await publishedDefinition(tx);
    const e = definition.entities.find((x) => customResource(x.key) === type);
    if (!e) return null;
    const d = authorize(principal, action('platform:records.read'), { type, id, tenantId: principal.tenantId });
    if (d.decision === 'deny') return null;
    // The title obeys field rules and formulas like any other value.
    const hidden = hiddenForPrincipal(principal, definition, e, d);
    const r = await tx.selectFrom('custom_record').select('data').where('id', '=', id).executeTakeFirst();
    let title: string | null = null;
    if (r && !hidden.has(e.title_field) && !e.fields.find((f) => f.key === e.title_field)?.formula) {
      const v = decryptDefined(p.ports.vault, principal.tenantId, `custom:${e.key}`, e.fields, r.data as Record<string, unknown>)[e.title_field];
      title = v === null || v === undefined ? null : String(v);
    }
    return { app: 'custom', entity: e.key, label: e.label, title: r ? (title ?? id.slice(0, 8)) : null, path: `/data/${e.key}/${id}` };
  }
  for (const m of p.catalog.manifests()) {
    const e = m.entities.find((x) => x.resource === type);
    if (!e) continue;
    const d = authorize(principal, action(readPermission(m.id, e)), { type, id, tenantId: principal.tenantId });
    if (d.decision === 'deny') return null;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const titleField = e.title_field && d.fields[e.title_field] !== 'hidden' && !e.fields.find((f) => f.key === e.title_field)?.pii ? e.title_field : null;
    const r = titleField ? await tx.selectFrom(e.table).select(sql<string>`${sql.ref(titleField)}::text`.as('t')).where('id', '=', id).executeTakeFirst() : null;
    const routes: Record<string, string> = { 'ordering:order': `/apps/ordering/${id}`, 'pos:sale': `/apps/pos/sales/${id}`, 'logistics:shipment': `/apps/logistics/${id}`, 'payments:payment': `/apps/payments/${id}` };
    return { app: m.id, entity: e.name, label: e.label, title: r?.t ?? null, path: routes[`${m.id}:${e.name}`] ?? null };
  }
  return null;
}

/** Links touching a record, both directions, with titles; records the principal cannot read are counted, not shown. */
export async function linksFor(p: Platform, tx: Tx, principal: Principal, type: string, id: string) {
  const rows = await tx
    .selectFrom('record_link')
    .selectAll()
    .where((eb) => eb.or([eb.and([eb('from_type', '=', type), eb('from_id', '=', id)]), eb.and([eb('to_type', '=', type), eb('to_id', '=', id)])]))
    .orderBy('created_at')
    .limit(200)
    .execute();
  const links = [];
  let hidden = 0;
  for (const r of rows) {
    const outgoing = r.from_type === type && r.from_id === id;
    const otherType = outgoing ? r.to_type : r.from_type;
    const otherId = outgoing ? r.to_id : r.from_id;
    const other = await resolve(p, tx, principal, otherType, otherId);
    if (!other) {
      hidden++;
      continue;
    }
    links.push({ direction: outgoing ? 'out' : 'in', rel: r.rel, type: otherType, id: otherId, ...other });
  }
  return { links, hidden };
}
