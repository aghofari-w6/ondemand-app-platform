import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { LinkedRecords } from '../components/links';
import { can, useMe } from '../components/shell';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, ModalDialog, PageHeader, Select, TextField } from '../components/ui';
import { api, ApiError, dateTime, label } from '../lib/api';

type Field = { key: string; label: string; type: string; options: string[]; required: boolean; pii: boolean; formula?: string; link?: string };
type Entity = { key: string; label: string; title_field: string; fields: Field[]; rollups: { key: string; label: string }[] };

const resourceOf = (key: string) => `custom::${key.replace(/(^|_)([a-z])/g, (_m, _p, c: string) => c.toUpperCase())}`;
const fmt = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));

export function RecordsIndexScreen() {
  const model = useQuery({ queryKey: ['data-model'], queryFn: () => api('/api/data-model') });
  const entities = (model.data?.entities ?? []) as Entity[];
  return (
    <>
      <PageHeader title="Custom records" description="Entities you defined in Data studio." />
      {entities.length === 0 ? (
        <EmptyState title="No custom entities yet">
          <Link to="/data-studio" className="font-medium text-accent underline">
            Define one in Data studio
          </Link>
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {entities.map((e) => (
            <li key={e.key}>
              <Link to={`/data/${e.key}`} className="flex min-h-11 items-center rounded-xl border border-line bg-white p-5 font-medium text-accent underline">
                {e.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function useEntity(key: string) {
  const model = useQuery({ queryKey: ['data-model'], queryFn: () => api('/api/data-model') });
  const entity = (model.data?.entities ?? []).find((e: Entity) => e.key === key) as Entity | undefined;
  const layouts = ((model.data?.layouts ?? []) as any[]).filter((l) => l.target === `custom:${key}`);
  return { model, entity, layouts };
}

export function RecordsScreen() {
  const { entity: key } = useParams({ strict: false }) as { entity: string };
  const me = useMe();
  const { model, entity, layouts } = useEntity(key);
  const board = layouts.find((l) => l.kind === 'board');
  const listLayout = layouts.find((l) => l.kind === 'list');
  const [view, setView] = useState<'list' | 'board'>('list');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ['records', key, q], queryFn: () => api(`/api/data/${key}?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`), enabled: Boolean(entity) });
  if (model.isPending) return <p className="text-muted">Loading…</p>;
  if (!entity) return <EmptyState title="Unknown entity">This entity is not in the published data model.</EmptyState>;
  const columns: string[] = listLayout?.columns?.length ? listLayout.columns : [entity.title_field, ...entity.fields.filter((f) => f.key !== entity.title_field).slice(0, 4).map((f) => f.key), ...entity.rollups.map((r) => r.key)].slice(0, 6);
  const labelOf = (k: string) => entity.fields.find((f) => f.key === k)?.label ?? entity.rollups.find((r) => r.key === k)?.label ?? label(k);
  const items = (list.data?.items ?? []) as any[];
  const canWrite = can(me.data, 'platform:records.write');

  return (
    <>
      <PageHeader title={entity.label} description={`${items.length} record${items.length === 1 ? '' : 's'}`} actions={canWrite && <Button onPress={() => setCreating(true)}>New {entity.label.toLowerCase()}</Button>} />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <TextField label={`Search ${entity.label.toLowerCase()}`} value={q} onChange={setQ} type="search" className="min-w-64 flex-1" />
        {board && (
          <div role="group" aria-label="View" className="flex gap-2">
            <Button variant={view === 'list' ? 'primary' : 'secondary'} aria-pressed={view === 'list'} onPress={() => setView('list')}>
              List
            </Button>
            <Button variant={view === 'board' ? 'primary' : 'secondary'} aria-pressed={view === 'board'} onPress={() => setView('board')}>
              Board
            </Button>
          </div>
        )}
      </div>
      {list.error && <Alert tone="error">{(list.error as ApiError).message}</Alert>}
      {view === 'board' && board ? (
        <Board entity={entity} items={items} groupBy={board.group_by} cardFields={board.card_fields ?? []} />
      ) : (
        <Card as="div" className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">{entity.label} records</caption>
              <thead className="text-muted">
                <tr>
                  {columns.map((c) => (
                    <th key={c} scope="col" className="px-4 py-3 font-medium">
                      {labelOf(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} className="border-t border-line">
                    {columns.map((c, i) => (
                      <td key={c} className="px-4 py-2 whitespace-nowrap">
                        {i === 0 ? (
                          <Link to={`/data/${key}/${r.id}`} className="inline-flex min-h-11 items-center font-medium text-accent underline">
                            {fmt(r.values[c] ?? r.title)}
                          </Link>
                        ) : (
                          fmt(r.values[c])
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {items.length === 0 && !list.isPending && <p className="p-6 text-center text-muted">No records yet.</p>}
        </Card>
      )}
      {creating && <RecordForm entity={entity} layouts={layouts} onClose={() => setCreating(false)} />}
    </>
  );
}

function Board({ entity, items, groupBy, cardFields }: { entity: Entity; items: any[]; groupBy: string; cardFields: string[] }) {
  const f = entity.fields.find((x) => x.key === groupBy);
  const groups = [...(f?.options ?? []), '—'];
  return (
    <div className="grid gap-3 md:grid-cols-3" role="list" aria-label={`${entity.label} board grouped by ${f?.label ?? groupBy}`}>
      {groups.map((g) => {
        const col = items.filter((r) => (r.values[groupBy] ?? '—') === g);
        if (g === '—' && col.length === 0) return null;
        return (
          <section key={g} role="listitem" aria-label={`${label(g)}: ${col.length}`} className="rounded-xl border border-line bg-white p-3">
            <h2 className="mb-2 flex items-center justify-between text-sm font-semibold">
              {label(g)} <Badge value={String(col.length)} />
            </h2>
            <ul className="flex flex-col gap-2">
              {col.map((r) => (
                <li key={r.id} className="rounded-lg border border-line p-3">
                  <Link to={`/data/${entity.key}/${r.id}`} className="font-medium text-accent underline">
                    {fmt(r.title)}
                  </Link>
                  {cardFields.map((c) => (
                    <p key={c} className="text-sm text-muted">
                      {entity.fields.find((x) => x.key === c)?.label ?? c}: {fmt(r.values[c])}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function RecordForm({ entity, layouts, record, onClose }: { entity: Entity; layouts: any[]; record?: any; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const form = layouts.find((l) => l.kind === 'form');
  const writable = entity.fields.filter((f) => !f.formula);
  const order: string[] = form?.sections?.flatMap((s: any) => s.fields) ?? writable.map((f) => f.key);
  const fields = [...order.map((k) => writable.find((f) => f.key === k)).filter(Boolean), ...writable.filter((f) => !order.includes(f.key))] as Field[];
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map((f) => [f.key, record?.values?.[f.key] ?? (f.type === 'boolean' ? false : '')])));
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const v = values[f.key];
      if (v === '' || v === undefined) {
        if (record) out[f.key] = null;
        continue;
      }
      out[f.key] = f.type === 'number' ? Number(v) : v;
    }
    try {
      if (record) await api(`/api/data/${entity.key}/${record.id}`, { method: 'PATCH', body: { version: record.version, values: out } });
      else {
        const r = await api(`/api/data/${entity.key}`, { body: { values: out }, headers: { 'Idempotency-Key': `ui-${crypto.randomUUID()}` } });
        void navigate({ to: `/data/${entity.key}/${r.id}` });
      }
      await qc.invalidateQueries({ queryKey: ['records', entity.key] });
      await qc.invalidateQueries({ queryKey: ['record', entity.key] });
      onClose();
    } catch (err) {
      setError((err as ApiError).message);
    }
  };
  return (
    <ModalDialog title={record ? `Edit ${entity.label.toLowerCase()}` : `New ${entity.label.toLowerCase()}`} isOpen onOpenChange={(o) => !o && onClose()}>
      <form onSubmit={submit} className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto">
        {fields.map((f) =>
          f.type === 'boolean' ? (
            <Checkbox key={f.key} isSelected={Boolean(values[f.key])} onChange={(v) => setValues({ ...values, [f.key]: v })}>
              {f.label}
            </Checkbox>
          ) : f.type === 'select' ? (
            <Select key={f.key} label={f.label + (f.required ? ' *' : '')} value={(values[f.key] as string) || null} onChange={(v) => setValues({ ...values, [f.key]: v })} options={f.options.map((o) => ({ id: o, label: o }))} />
          ) : f.type === 'link' ? (
            <LinkPicker key={f.key} field={f} value={(values[f.key] as string) || ''} onChange={(v) => setValues({ ...values, [f.key]: v })} />
          ) : (
            <TextField
              key={f.key}
              label={f.label + (f.required ? ' *' : '') + (f.pii ? ' (private)' : '')}
              type={f.type === 'date' ? 'date' : 'text'}
              inputMode={f.type === 'number' ? 'decimal' : 'text'}
              value={String(values[f.key] ?? '')}
              onChange={(v) => setValues({ ...values, [f.key]: v })}
            />
          ),
        )}
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button type="submit">Save</Button>
        </div>
      </form>
    </ModalDialog>
  );
}

function LinkPicker({ field, value, onChange }: { field: Field; value: string; onChange: (v: string) => void }) {
  const [scope, name] = (field.link ?? '').split(':') as [string, string];
  const q = useQuery({ queryKey: ['link-options', field.link], queryFn: () => (scope === 'custom' ? api(`/api/data/${name}?limit=200`) : api(`/api/apps/${scope}/entities/${name}?limit=100`)) });
  const items = ((q.data?.items ?? []) as any[]).map((r) => ({ id: r.id as string, label: String(scope === 'custom' ? (r.title ?? r.id) : (r.number ?? r.tracking_no ?? r.receipt_no ?? r.reference ?? r.id)) }));
  return <Select label={field.label} value={value || null} onChange={onChange} options={items} />;
}

export function RecordDetailScreen() {
  const { entity: key, id } = useParams({ strict: false }) as { entity: string; id: string };
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { entity, layouts } = useEntity(key);
  const q = useQuery({ queryKey: ['record', key, id], queryFn: () => api(`/api/data/${key}/${id}`), refetchInterval: 4000 });
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [id]);
  if (q.error) return <Alert tone="error">{(q.error as ApiError).message}</Alert>;
  if (!q.data || !entity) return <p className="text-muted">Loading…</p>;
  const { item, events } = q.data;
  const remove = async () => {
    try {
      await api(`/api/data/${key}/${id}?version=${item.version}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['records', key] });
      void navigate({ to: `/data/${key}` });
    } catch (e) {
      setError((e as ApiError).message);
    }
  };
  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">
            <Link to={`/data/${key}`} className="underline">
              {entity.label}
            </Link>
          </p>
          <h1 className="text-2xl font-semibold">{fmt(item.title)}</h1>
        </div>
        {can(me.data, 'platform:records.write') && (
          <div className="flex gap-2">
            <Button onPress={() => setEditing(true)}>Edit</Button>
            <Button variant="danger" onPress={remove}>
              Delete
            </Button>
          </div>
        )}
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-4">
          <Card title="Details">
            <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
              {[...entity.fields.map((f) => [f.key, f.label + (f.formula ? ' (formula)' : '')]), ...entity.rollups.map((r) => [r.key, `${r.label} (rollup)`])].map(([k, l]) =>
                k! in item.values ? (
                  <div key={k} className="contents">
                    <dt className="text-muted">{l}</dt>
                    <dd>{fmt(item.values[k!])}</dd>
                  </div>
                ) : null,
              )}
              <dt className="text-muted">Version</dt>
              <dd>{item.version}</dd>
            </dl>
          </Card>
          <LinkedRecords type={resourceOf(key)} id={id} />
        </div>
        <Card title="Events">
          <ol className="flex flex-col gap-3 text-sm">
            {events.map((e: any) => (
              <li key={e.id} className="border-l-2 border-accent pl-3">
                <p className="font-medium">
                  <code>{e.type}</code> {e.pending && <span className="text-muted">(dispatching)</span>}
                </p>
                <p className="text-muted">
                  {dateTime(e.occurred_at)} · {e.origin}
                </p>
              </li>
            ))}
          </ol>
        </Card>
      </div>
      {editing && <RecordForm entity={entity} layouts={layouts} record={item} onClose={() => setEditing(false)} />}
    </>
  );
}
