import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { can, useMe } from '../components/shell';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, ModalDialog, PageHeader, Select, TextField } from '../components/ui';
import { api, ApiError, dateTime } from '../lib/api';

type Field = { key: string; label: string; type: string; options: string[]; required: boolean; pii: boolean; indexed: boolean; default: string | number | boolean | null; formula?: string; link?: string };
type Entity = { key: string; label: string; title_field: string; fields: Field[]; rollups: any[]; rules: any[] };
type Def = { app_fields: { app: string; entity: string; fields: Field[] }[]; entities: Entity[]; layouts: any[]; field_access: any[] };

const toKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 40);
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

export function DataStudioScreen() {
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['datastudio'], queryFn: () => api('/api/datastudio'), enabled: can(me.data, 'platform:datastudio.manage') });
  const [tab, setTab] = useState<'entities' | 'app' | 'layouts' | 'access' | 'history'>('entities');
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);

  if (!can(me.data, 'platform:datastudio.manage')) return <EmptyState title="Data studio">Only Owners and Admins can change the data model.</EmptyState>;
  if (!q.data) return <p className="text-muted">Loading…</p>;
  const d = q.data;
  const draft = d.draft as { number: number; version: number; definition: Def; problems: string[] } | null;
  const def: Def = draft?.definition ?? d.published.definition;
  const refresh = () => qc.invalidateQueries({ queryKey: ['datastudio'] });
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as ApiError).message);
    }
    await refresh();
  };
  const save = (next: Def) => run(() => api('/api/datastudio/draft', { method: 'PUT', body: { definition: next, version: draft!.version } }));
  const edit = (fn: (x: Def) => void) => {
    const next = clone(def);
    fn(next);
    return save(next);
  };

  return (
    <>
      <PageHeader
        title="Data studio"
        description={
          <>
            Published version {d.published.number || '—'}
            {draft ? ` · editing draft ${draft.number}` : ''} · plan allows {d.context.limits.custom_entities} custom entities and {d.context.limits.custom_fields} custom fields
          </>
        }
        actions={
          draft ? (
            <>
              <Button onPress={() => setReviewing(true)}>Review and publish</Button>
              <Button variant="secondary" onPress={() => run(() => api('/api/datastudio/draft', { method: 'DELETE' }))}>
                Discard draft
              </Button>
            </>
          ) : (
            <Button onPress={() => run(() => api('/api/datastudio/draft', { body: {} }))}>Start a draft</Button>
          )
        }
      />
      {error && (
        <div className="mb-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      {draft && draft.problems.length > 0 && (
        <div className="mb-4">
          <Alert tone="warn" title="Fix these before publishing">
            <ul className="list-disc pl-5">
              {draft.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        </div>
      )}
      {!draft && <p className="mb-4 text-muted">You are looking at the published model. Start a draft to change it; nothing changes for users until you publish.</p>}
      {d.published.definition.entities.length > 0 && (
        <Card className="mb-4" title="Records">
          <ul className="flex flex-wrap gap-2">
            {d.published.definition.entities.map((e: Entity) => (
              <li key={e.key}>
                <Link to={`/data/${e.key}`} className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-medium">
                  Open {e.label} records
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <div role="group" aria-label="Sections" className="mb-4 flex flex-wrap gap-2">
        {(
          [
            ['entities', 'Custom entities'],
            ['app', 'Fields on app records'],
            ['layouts', 'Layouts'],
            ['access', 'Field access'],
            ['history', 'History'],
          ] as const
        ).map(([k, l]) => (
          <Button key={k} variant={tab === k ? 'primary' : 'secondary'} aria-pressed={tab === k} onPress={() => setTab(k)}>
            {l}
          </Button>
        ))}
      </div>
      {tab === 'entities' && <EntitiesPanel def={def} editable={Boolean(draft)} edit={edit} context={d.context} />}
      {tab === 'app' && <AppFieldsPanel def={def} editable={Boolean(draft)} edit={edit} context={d.context} />}
      {tab === 'layouts' && <LayoutsPanel def={def} editable={Boolean(draft)} edit={edit} context={d.context} />}
      {tab === 'access' && <AccessPanel def={def} editable={Boolean(draft)} edit={edit} context={d.context} />}
      {tab === 'history' && <HistoryPanel data={d} hasDraft={Boolean(draft)} run={run} />}
      {draft && reviewing && <PublishDialog version={draft.version} onClose={() => setReviewing(false)} onDone={refresh} />}
    </>
  );
}

// ---------------------------------------------------------------- fields

function FieldForm(props: { onAdd: (f: Field) => void; allowFormula: boolean; linkTargets?: { id: string; label: string }[] }) {
  const empty = { label: '', key: '', type: 'text', options: '', required: false, pii: false, indexed: false, def: '', formula: '', link: '' };
  const [f, setF] = useState(empty);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const key = f.key || toKey(f.label);
    const dflt = f.def === '' ? null : f.type === 'number' ? Number(f.def) : f.type === 'boolean' ? f.def === 'true' : f.def;
    props.onAdd({
      key,
      label: f.label,
      type: f.type,
      options: f.type === 'select' ? f.options.split(',').map((s) => s.trim()).filter(Boolean) : [],
      required: f.required,
      pii: f.pii,
      indexed: f.indexed,
      default: dflt,
      ...(f.formula ? { formula: f.formula } : {}),
      ...(f.type === 'link' ? { link: f.link } : {}),
    });
    setF(empty);
  };
  return (
    <form onSubmit={submit} className="mt-3 grid gap-3 rounded-lg border border-dashed border-line p-3 sm:grid-cols-2">
      <TextField label="Field label" value={f.label} onChange={(v) => setF({ ...f, label: v })} isRequired />
      <TextField label="Field key" value={f.key || toKey(f.label)} onChange={(v) => setF({ ...f, key: v })} description="lower_snake_case" />
      <Select label="Type" value={f.type} onChange={(v) => setF({ ...f, type: v })} options={['text', 'number', 'boolean', 'date', 'select', ...(props.linkTargets ? ['link'] : [])].map((t) => ({ id: t, label: t }))} />
      {f.type === 'select' && <TextField label="Options (comma separated)" value={f.options} onChange={(v) => setF({ ...f, options: v })} />}
      {f.type === 'link' && props.linkTargets && <Select label="Links to" value={f.link || null} onChange={(v) => setF({ ...f, link: v })} options={props.linkTargets} />}
      <TextField label="Default for existing records" value={f.def} onChange={(v) => setF({ ...f, def: v })} description="Optional; filled in by a backfill" />
      {props.allowFormula && <TextField label="Formula (makes it computed)" value={f.formula} onChange={(v) => setF({ ...f, formula: v })} placeholder="e.g. qty * price" />}
      <div className="flex flex-wrap gap-x-4 sm:col-span-2">
        <Checkbox isSelected={f.required} onChange={(v) => setF({ ...f, required: v })}>
          Required
        </Checkbox>
        <Checkbox isSelected={f.pii} onChange={(v) => setF({ ...f, pii: v })}>
          PII (encrypted at rest)
        </Checkbox>
        <Checkbox isSelected={f.indexed} onChange={(v) => setF({ ...f, indexed: v })}>
          Indexed
        </Checkbox>
      </div>
      <Button type="submit" variant="secondary" className="sm:col-span-2" isDisabled={!f.label}>
        Add field
      </Button>
    </form>
  );
}

function FieldTable({ fields, onRemove, onTogglePii }: { fields: Field[]; onRemove?: (k: string) => void; onTogglePii?: (k: string) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-muted">
          <tr>
            <th scope="col" className="py-2 font-medium">Field</th>
            <th scope="col" className="py-2 font-medium">Type</th>
            <th scope="col" className="py-2 font-medium">Flags</th>
            {onRemove && <th scope="col" className="py-2 font-medium"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.key} className="border-t border-line">
              <td className="py-2">
                {f.label} <code className="text-muted">{f.key}</code>
              </td>
              <td className="py-2">
                {f.type}
                {f.type === 'select' ? `: ${f.options.join(', ')}` : ''}
                {f.link ? ` → ${f.link}` : ''}
                {f.formula ? <span className="block text-muted">= {f.formula}</span> : null}
              </td>
              <td className="py-2">{[f.required && 'required', f.pii && 'PII', f.indexed && 'indexed', f.default !== null && f.default !== undefined && `default ${String(f.default)}`].filter(Boolean).join(' · ') || '—'}</td>
              {onRemove && (
                <td className="py-2 text-right whitespace-nowrap">
                  {onTogglePii && (
                    <Button variant="ghost" onPress={() => onTogglePii(f.key)}>
                      {f.pii ? 'Unmark PII' : 'Mark PII'}
                    </Button>
                  )}
                  <Button variant="ghost" onPress={() => onRemove(f.key)} aria-label={`Remove ${f.label}`}>
                    Remove
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type PanelProps = { def: Def; editable: boolean; edit: (fn: (d: Def) => void) => Promise<void>; context: any };

function EntitiesPanel({ def, editable, edit, context }: PanelProps) {
  const [label, setLabel] = useState('');
  const [titleField, setTitleField] = useState('name');
  const linkTargets = [...def.entities.map((e) => ({ id: `custom:${e.key}`, label: e.label })), ...Object.keys(context.allAppEntities).map((t) => ({ id: t, label: t }))];
  return (
    <div className="flex flex-col gap-4">
      {def.entities.length === 0 && <p className="text-muted">No custom entities yet.</p>}
      {def.entities.map((e) => (
        <Card key={e.key} title={`${e.label} (${e.key})`}>
          <FieldTable
            fields={e.fields}
            {...(editable
              ? {
                  onRemove: (k) => void edit((d) => void (d.entities.find((x) => x.key === e.key)!.fields = d.entities.find((x) => x.key === e.key)!.fields.filter((f) => f.key !== k))),
                  onTogglePii: (k) => void edit((d) => { const f = d.entities.find((x) => x.key === e.key)!.fields.find((x) => x.key === k)!; f.pii = !f.pii; }),
                }
              : {})}
          />
          <p className="mt-2 text-sm text-muted">Title field: {e.title_field}</p>
          {e.rollups.length > 0 && (
            <p className="mt-1 text-sm">
              Rollups: {e.rollups.map((r: any) => `${r.label} = ${r.aggregate}(${r.from}${r.field ? `.${r.field}` : ''})`).join('; ')}
            </p>
          )}
          {e.rules.length > 0 && (
            <ul className="mt-1 text-sm">
              {e.rules.map((r: any) => (
                <li key={r.name}>
                  Rule “{r.name}”: <code>{r.condition}</code> — {r.message}
                </li>
              ))}
            </ul>
          )}
          {editable && (
            <>
              <FieldForm allowFormula linkTargets={linkTargets} onAdd={(f) => edit((d) => void d.entities.find((x) => x.key === e.key)!.fields.push(f))} />
              <RuleForm onAdd={(r) => edit((d) => void d.entities.find((x) => x.key === e.key)!.rules.push(r))} />
              <RollupForm entities={def.entities.filter((x) => x.fields.some((f) => f.type === 'link' && f.link === `custom:${e.key}`))} target={e.key} onAdd={(r) => edit((d) => void d.entities.find((x) => x.key === e.key)!.rollups.push(r))} />
              <Button variant="danger" className="mt-3" onPress={() => edit((d) => void (d.entities = d.entities.filter((x) => x.key !== e.key)))}>
                Remove {e.label}
              </Button>
            </>
          )}
        </Card>
      ))}
      {editable && (
        <Card title="Add a custom entity">
          <form
            className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            onSubmit={(ev) => {
              ev.preventDefault();
              const key = toKey(label);
              void edit((d) => void d.entities.push({ key, label, title_field: toKey(titleField), fields: [{ key: toKey(titleField), label: titleField, type: 'text', options: [], required: true, pii: false, indexed: false, default: null }], rollups: [], rules: [] }));
              setLabel('');
            }}
          >
            <TextField label="Entity name" value={label} onChange={setLabel} placeholder="e.g. Supplier" isRequired />
            <TextField label="Title field label" value={titleField} onChange={setTitleField} />
            <Button type="submit" isDisabled={!label}>
              Add entity
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}

function RuleForm({ onAdd }: { onAdd: (r: { name: string; condition: string; message: string; when?: string }) => void }) {
  const [r, setR] = useState({ name: '', when: '', condition: '', message: '' });
  return (
    <form
      className="mt-3 grid gap-3 rounded-lg border border-dashed border-line p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        onAdd({ name: r.name, condition: r.condition, message: r.message, ...(r.when ? { when: r.when } : {}) });
        setR({ name: '', when: '', condition: '', message: '' });
      }}
    >
      <TextField label="Rule name" value={r.name} onChange={(v) => setR({ ...r, name: v })} />
      <TextField label="Applies when (optional)" value={r.when} onChange={(v) => setR({ ...r, when: v })} placeholder="discount != null" />
      <TextField label="Must be true" value={r.condition} onChange={(v) => setR({ ...r, condition: v })} placeholder="discount <= 30" />
      <TextField label="Error message" value={r.message} onChange={(v) => setR({ ...r, message: v })} />
      <Button type="submit" variant="secondary" className="sm:col-span-2" isDisabled={!r.name || !r.condition || !r.message}>
        Add rule
      </Button>
    </form>
  );
}

function RollupForm({ entities, target, onAdd }: { entities: Entity[]; target: string; onAdd: (r: any) => void }) {
  const [r, setR] = useState({ label: '', from: '', aggregate: 'count', field: '' });
  if (!entities.length) return <p className="mt-3 text-sm text-muted">Rollups appear when another entity has a link field to this one.</p>;
  const child = entities.find((e) => e.key === r.from);
  const via = child?.fields.find((f) => f.type === 'link' && f.link === `custom:${target}`)?.key;
  return (
    <form
      className="mt-3 grid gap-3 rounded-lg border border-dashed border-line p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        onAdd({ key: toKey(r.label), label: r.label, from: r.from, via, aggregate: r.aggregate, ...(r.aggregate !== 'count' ? { field: r.field } : {}) });
        setR({ label: '', from: '', aggregate: 'count', field: '' });
      }}
    >
      <TextField label="Rollup label" value={r.label} onChange={(v) => setR({ ...r, label: v })} />
      <Select label="From" value={r.from || null} onChange={(v) => setR({ ...r, from: v })} options={entities.map((e) => ({ id: e.key, label: e.label }))} />
      <Select label="Aggregate" value={r.aggregate} onChange={(v) => setR({ ...r, aggregate: v })} options={['count', 'sum', 'min', 'max'].map((a) => ({ id: a, label: a }))} />
      {r.aggregate !== 'count' && <Select label="Number field" value={r.field || null} onChange={(v) => setR({ ...r, field: v })} options={(child?.fields ?? []).filter((f) => f.type === 'number').map((f) => ({ id: f.key, label: f.label }))} />}
      <Button type="submit" variant="secondary" className="sm:col-span-2" isDisabled={!r.label || !r.from || !via}>
        Add rollup
      </Button>
    </form>
  );
}

function AppFieldsPanel({ def, editable, edit, context }: PanelProps) {
  const [target, setTarget] = useState<string>(context.appEntities[0] ?? '');
  const [app, entity] = target.split(':');
  const set = def.app_fields.find((s) => s.app === app && s.entity === entity);
  return (
    <Card>
      <Select label="Record type" value={target} onChange={setTarget} options={context.appEntities.map((t: string) => ({ id: t, label: t }))} />
      <div className="mt-3">
        <FieldTable
          fields={set?.fields ?? []}
          {...(editable
            ? {
                onRemove: (k) => void edit((d) => { const s = d.app_fields.find((x) => x.app === app && x.entity === entity)!; s.fields = s.fields.filter((f) => f.key !== k); }),
                onTogglePii: (k) => void edit((d) => { const f = d.app_fields.find((x) => x.app === app && x.entity === entity)!.fields.find((x) => x.key === k)!; f.pii = !f.pii; }),
              }
            : {})}
        />
      </div>
      {editable && (
        <FieldForm
          allowFormula={false}
          onAdd={(f) =>
            edit((d) => {
              let s = d.app_fields.find((x) => x.app === app && x.entity === entity);
              if (!s) d.app_fields.push((s = { app: app!, entity: entity!, fields: [] }));
              s.fields.push(f);
            })
          }
        />
      )}
    </Card>
  );
}

function LayoutsPanel({ def, editable, edit, context }: PanelProps) {
  const targets = [...def.entities.map((e) => `custom:${e.key}`), ...context.appEntities];
  const [l, setL] = useState({ target: targets[0] ?? '', kind: 'list', columns: '', group_by: '', card_fields: '', section: '' });
  return (
    <Card>
      <ul className="mb-3 text-sm">
        {def.layouts.map((x, i) => (
          <li key={i} className="flex min-h-11 items-center justify-between">
            <span>
              {x.kind} · {x.target} {x.columns.length ? `· columns ${x.columns.join(', ')}` : ''} {x.group_by ? `· grouped by ${x.group_by}` : ''}
            </span>
            {editable && (
              <Button variant="ghost" onPress={() => edit((d) => void d.layouts.splice(i, 1))}>
                Remove
              </Button>
            )}
          </li>
        ))}
        {def.layouts.length === 0 && <li className="text-muted">No layouts: screens use all fields in order.</li>}
      </ul>
      {editable && (
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
            void edit((d) =>
              void d.layouts.push({
                target: l.target,
                kind: l.kind,
                columns: l.kind === 'list' ? list(l.columns) : [],
                sections: l.kind === 'form' ? [{ title: 'Details', fields: list(l.section) }] : [],
                ...(l.kind === 'board' ? { group_by: l.group_by } : {}),
                card_fields: l.kind === 'board' ? list(l.card_fields) : [],
              }),
            );
          }}
        >
          <Select label="Target" value={l.target} onChange={(v) => setL({ ...l, target: v })} options={targets.map((t: string) => ({ id: t, label: t }))} />
          <Select label="Kind" value={l.kind} onChange={(v) => setL({ ...l, kind: v })} options={['list', 'form', 'board'].map((k) => ({ id: k, label: k }))} />
          {l.kind === 'list' && <TextField label="Columns (field keys, comma separated)" value={l.columns} onChange={(v) => setL({ ...l, columns: v })} />}
          {l.kind === 'form' && <TextField label="Form fields in order (comma separated)" value={l.section} onChange={(v) => setL({ ...l, section: v })} />}
          {l.kind === 'board' && (
            <>
              <TextField label="Group by (a select field)" value={l.group_by} onChange={(v) => setL({ ...l, group_by: v })} />
              <TextField label="Card fields (comma separated)" value={l.card_fields} onChange={(v) => setL({ ...l, card_fields: v })} />
            </>
          )}
          <Button type="submit" variant="secondary" className="sm:col-span-2">
            Add layout
          </Button>
        </form>
      )}
    </Card>
  );
}

function AccessPanel({ def, editable, edit, context }: PanelProps) {
  const targets = [...def.entities.map((e) => `custom:${e.key}`), ...Object.keys(context.allAppEntities)];
  const [a, setA] = useState({ role: 'Staff', target: targets[0] ?? '', field: '', access: 'hidden' });
  return (
    <Card>
      <p className="mb-3 text-sm text-muted">Hide a field from a role, or make it read-only. Applies everywhere the role reads or writes the record, including the API.</p>
      <ul className="mb-3 text-sm">
        {def.field_access.map((x, i) => (
          <li key={i} className="flex min-h-11 items-center justify-between">
            <span>
              {context.roles.find((r: any) => r.id === x.role)?.name ?? x.role}: {x.target}.{x.field} → <strong>{x.access}</strong>
            </span>
            {editable && (
              <Button variant="ghost" onPress={() => edit((d) => void d.field_access.splice(i, 1))}>
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void edit((d) => void d.field_access.push(a));
          }}
        >
          <Select label="Role" value={a.role} onChange={(v) => setA({ ...a, role: v })} options={context.roles.filter((r: any) => r.id !== 'Owner').map((r: any) => ({ id: r.id, label: r.name }))} />
          <Select label="Record type" value={a.target} onChange={(v) => setA({ ...a, target: v })} options={targets.map((t) => ({ id: t, label: t }))} />
          <TextField label="Field key" value={a.field} onChange={(v) => setA({ ...a, field: v })} description="custom.<key> for custom fields on app records" />
          <Select label="Access" value={a.access} onChange={(v) => setA({ ...a, access: v })} options={['hidden', 'read', 'write'].map((x) => ({ id: x, label: x }))} />
          <Button type="submit" variant="secondary" className="sm:col-span-2" isDisabled={!a.field}>
            Add rule
          </Button>
        </form>
      )}
    </Card>
  );
}

function HistoryPanel({ data, hasDraft, run }: { data: any; hasDraft: boolean; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  return (
    <div className="flex flex-col gap-4">
      <Card title="Versions">
        <table className="w-full text-left text-sm">
          <thead className="text-muted">
            <tr>
              <th scope="col" className="py-2 font-medium">Version</th>
              <th scope="col" className="py-2 font-medium">Status</th>
              <th scope="col" className="py-2 font-medium">Published</th>
              <th scope="col" className="py-2 font-medium">Changes</th>
              <th scope="col" className="py-2 font-medium"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {data.history.map((v: any) => (
              <tr key={v.number} className="border-t border-line">
                <td className="py-2">
                  {v.number} {v.note && <span className="text-muted">· {v.note}</span>}
                </td>
                <td className="py-2">
                  <Badge value={v.status} />
                </td>
                <td className="py-2">{dateTime(v.published_at)}</td>
                <td className="py-2">{v.impact ? `${v.impact.changes.length} changes, ${v.impact.backfills.length} backfills, ${v.impact.indexes.length} index jobs` : '—'}</td>
                <td className="py-2 text-right">
                  {v.status === 'superseded' && (
                    <Button variant="secondary" isDisabled={hasDraft} onPress={() => run(() => api('/api/datastudio/rollback', { body: { number: v.number } }))}>
                      Restore
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {hasDraft && <p className="mt-2 text-sm text-muted">Publish or discard the draft to restore an earlier version.</p>}
      </Card>
      <Card title="Backfills and indexes">
        <ul className="text-sm">
          {data.backfills.map((b: any) => (
            <li key={b.id} className="flex min-h-11 items-center gap-2">
              <Badge value={b.status === 'done' ? 'succeeded' : b.status} /> {b.kind} {b.target}.{b.field} · {b.processed} records {b.error ? `· ${b.error}` : ''}
            </li>
          ))}
          {data.indexes.map((i: any) => (
            <li key={i.id} className="flex min-h-11 items-center gap-2">
              <Badge value={i.status === 'ready' ? 'succeeded' : i.status} /> {i.op} index on {i.target}.{i.field} {i.error ? `· ${i.error}` : ''}
            </li>
          ))}
          {data.backfills.length + data.indexes.length === 0 && <li className="text-muted">Nothing yet.</li>}
        </ul>
      </Card>
    </div>
  );
}

function PublishDialog({ version, onClose, onDone }: { version: number; onClose: () => void; onDone: () => void }) {
  const q = useQuery({ queryKey: ['impact', version], queryFn: () => api('/api/datastudio/draft/impact') });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/datastudio/draft/publish', { body: { version } });
      onDone();
      onClose();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const i = q.data?.impact;
  const blocked = (q.data?.problems.length ?? 1) > 0 || (i?.blocking.length ?? 1) > 0;
  return (
    <ModalDialog title="Review and publish" isOpen onOpenChange={(o) => !o && onClose()}>
      {!q.data ? (
        <p className="text-muted">Calculating impact…</p>
      ) : (
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto text-sm">
          {q.data.problems.length > 0 && <Alert tone="error" title="Problems">{q.data.problems.join('; ')}</Alert>}
          {i.blocking.length > 0 && <Alert tone="error" title="Blocking">{i.blocking.join('; ')}</Alert>}
          {i.warnings.length > 0 && <Alert tone="warn">{i.warnings.join('; ')}</Alert>}
          <h3 className="font-semibold">Changes</h3>
          <ul className="list-disc pl-5">
            {i.changes.map((c: any, n: number) => (
              <li key={n}>
                {c.target}: {c.change} — {c.detail}
                {c.records !== undefined ? ` (${c.records} records)` : ''}
              </li>
            ))}
            {i.changes.length === 0 && <li>No changes.</li>}
          </ul>
          {i.backfills.length > 0 && (
            <p>
              Backfills: {i.backfills.map((b: any) => `${b.kind} ${b.target}.${b.field} (${b.records})`).join(', ')}
            </p>
          )}
          {i.indexes.length > 0 && <p>Index jobs: {i.indexes.map((x: any) => `${x.op} ${x.target}.${x.field}`).join(', ')}</p>}
        </div>
      )}
      {error && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onPress={onClose}>
          Cancel
        </Button>
        <Button onPress={publish} isDisabled={blocked || busy}>
          Publish
        </Button>
      </div>
    </ModalDialog>
  );
}
