import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, Select, TextField } from './ui';
import { api, ApiError, dateTime, label, money } from '../lib/api';

export interface EntityField {
  key: string;
  label: string;
  type: string;
  facet: boolean;
  sortable: boolean;
  options?: string[];
}
export interface AppMeta {
  id: string;
  name: string;
  installed: { status: string; version: string } | null;
  entities: { name: string; label: string; fields: EntityField[]; default_sort?: string; custom_fields: boolean }[];
  views: { name: string; label: string; entity: string }[];
  commands: { name: string; allowed: boolean }[];
  customFields: Record<string, { key: string; label: string; type: string; options: string[] }[]>;
  config: Record<string, any>;
}

export const useAppMeta = (app: string) =>
  useQuery<AppMeta, ApiError>({
    queryKey: ['meta', app],
    queryFn: () => api(`/api/apps/${app}/meta`),
    // keep checking while the app is being provisioned
    refetchInterval: (q) => (q.state.data && q.state.data.installed?.status !== 'active' ? 2000 : false),
  });

export const allowed = (meta: AppMeta | undefined, command: string) => Boolean(meta?.commands.find((c) => c.name === command)?.allowed);

export function formatValue(f: { type: string } | undefined, v: unknown, currency = 'IDR'): ReactNode {
  if (v === null || v === undefined || v === '') return '—';
  if (!f) return String(v);
  if (f.type === 'money') return money(v as number, currency);
  if (f.type === 'datetime' || f.type === 'date') return dateTime(String(v));
  if (f.type === 'boolean') return v ? 'Yes' : 'No';
  if (f.type === 'select') return <Badge value={String(v)} />;
  return String(v);
}

/** Requires the app to be active; otherwise points to the catalog. */
export function AppGate({ app, children }: { app: string; children: (meta: AppMeta) => ReactNode }) {
  const meta = useAppMeta(app);
  if (meta.isPending) return <p className="text-muted">Loading…</p>;
  if (meta.error) return <Alert tone="error">{meta.error.message}</Alert>;
  if (meta.data.installed?.status !== 'active') {
    return (
      <EmptyState title={`${meta.data.name} is not provisioned`}>
        <p>Provision it from the catalog to start using it.</p>
        <Link to="/catalog" className="mt-4 inline-flex min-h-11 items-center rounded-lg bg-accent px-4 font-medium text-white">
          Go to catalog
        </Link>
      </EmptyState>
    );
  }
  return <>{children(meta.data)}</>;
}

export function Workspace(props: {
  meta: AppMeta;
  entity: string;
  columns: string[];
  detailPath: (id: string) => string;
  initialView?: string;
  refreshKey?: number;
}) {
  const ent = props.meta.entities.find((e) => e.name === props.entity)!;
  const views = props.meta.views.filter((v) => v.entity === props.entity);
  const [view, setView] = useState<string>(props.initialView ?? views[0]?.name ?? '');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [sort, setSort] = useState<string>('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const params = new URLSearchParams();
  if (view) params.set('view', view);
  if (debounced) params.set('q', debounced);
  if (sort) params.set('sort', sort);
  for (const [k, v] of Object.entries(filters)) if (v.length) params.set(`f.${k}`, v.join(','));
  const base = `/api/apps/${props.meta.id}/entities/${props.entity}?${params}`;

  const list = useInfiniteQuery({
    queryKey: ['list', props.meta.id, props.entity, base, props.refreshKey],
    queryFn: ({ pageParam }) => api(`${base}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '' as string,
    getNextPageParam: (last: any) => last.nextCursor ?? undefined,
  });
  const first = list.data?.pages[0];
  const items = list.data?.pages.flatMap((p: any) => p.items) ?? [];
  const fields = new Map(ent.fields.map((f) => [f.key, f]));
  const custom = props.meta.customFields[props.entity] ?? [];
  const sortable = ent.fields.filter((f) => f.sortable);
  const currency = props.meta.config.currency ?? 'IDR';

  return (
    <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
      <Card title="Filters" className="h-fit">
        {Object.entries(first?.facets ?? {}).map(([key, values]: [string, any]) => (
          <fieldset key={key} className="mb-3">
            <legend className="text-sm font-semibold">{fields.get(key)?.label ?? label(key)}</legend>
            {values.length === 0 && <p className="text-sm text-muted">—</p>}
            {values.map((v: any) => (
              <Checkbox
                key={v.value}
                isSelected={(filters[key] ?? []).includes(v.value)}
                onChange={(sel) => setFilters((f) => ({ ...f, [key]: sel ? [...(f[key] ?? []), v.value] : (f[key] ?? []).filter((x) => x !== v.value) }))}
              >
                {label(v.value)} <span className="text-muted">({v.count})</span>
              </Checkbox>
            ))}
          </fieldset>
        ))}
      </Card>
      <div className="min-w-0">
        {views.length > 1 && (
          <div role="group" aria-label="Views" className="mb-3 flex flex-wrap gap-2">
            {views.map((v) => (
              <Button key={v.name} variant={view === v.name ? 'primary' : 'secondary'} aria-pressed={view === v.name} onPress={() => setView(v.name)}>
                {v.label}
              </Button>
            ))}
          </div>
        )}
        <div className="mb-3 grid gap-3 sm:grid-cols-[1fr_14rem]">
          <TextField label={`Search ${ent.label.toLowerCase()}s`} value={q} onChange={setQ} type="search" />
          <Select
            label="Sort by"
            value={sort || 'default'}
            onChange={(v) => setSort(v === 'default' ? '' : v)}
            options={[{ id: 'default', label: 'Default' }, ...sortable.flatMap((f) => [{ id: `-${f.key}`, label: `${f.label} ↓` }, { id: f.key, label: `${f.label} ↑` }])]}
          />
        </div>
        {list.error && <Alert tone="error">{(list.error as ApiError).message}</Alert>}
        <Card as="div" className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">{ent.label}s</caption>
              <thead className="text-muted">
                <tr>
                  {props.columns.map((c) => (
                    <th key={c} scope="col" className="px-4 py-3 font-medium">
                      {fields.get(c)?.label ?? label(c)}
                    </th>
                  ))}
                  {custom.slice(0, 2).map((c) => (
                    <th key={c.key} scope="col" className="px-4 py-3 font-medium">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((r: any) => (
                  <tr key={r.id} className="border-t border-line hover:bg-ground">
                    {props.columns.map((c, i) => (
                      <td key={c} className="px-4 py-2 whitespace-nowrap">
                        {i === 0 ? (
                          <Link to={props.detailPath(r.id)} className="inline-flex min-h-11 items-center font-medium text-accent underline">
                            {formatValue(fields.get(c), r[c], currency)}
                          </Link>
                        ) : (
                          formatValue(fields.get(c), r[c], currency)
                        )}
                      </td>
                    ))}
                    {custom.slice(0, 2).map((c) => (
                      <td key={c.key} className="px-4 py-2">
                        {formatValue({ type: c.type === 'select' ? 'text' : c.type }, r.custom?.[c.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {items.length === 0 && !list.isPending && <p className="p-6 text-center text-muted">Nothing here yet.</p>}
        </Card>
        {list.hasNextPage && (
          <Button variant="secondary" className="mt-3" onPress={() => list.fetchNextPage()} isDisabled={list.isFetchingNextPage}>
            Load more
          </Button>
        )}
        {first?.hiddenFields?.length > 0 && <p className="mt-2 text-sm text-muted">Hidden by your role: {first.hiddenFields.join(', ')}</p>}
      </div>
    </div>
  );
}

/** Detail: fields, custom fields, app-specific actions and the record's events. */
export function Detail(props: { meta: AppMeta; entity: string; id: string; title: (item: any) => string; actions?: (item: any, refresh: () => void) => ReactNode; extra?: (item: any) => ReactNode }) {
  const ent = props.meta.entities.find((e) => e.name === props.entity)!;
  const q = useQuery({ queryKey: ['detail', props.meta.id, props.entity, props.id], queryFn: () => api(`/api/apps/${props.meta.id}/entities/${props.entity}/${props.id}`), refetchInterval: 3000 });
  if (q.error) return <Alert tone="error">{(q.error as ApiError).message}</Alert>;
  if (!q.data) return <p className="text-muted">Loading…</p>;
  const { item, events } = q.data;
  const custom = props.meta.customFields[props.entity] ?? [];
  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">{ent.label}</p>
          <h1 className="text-2xl font-semibold">{props.title(item)}</h1>
        </div>
        <div className="flex flex-wrap gap-2">{props.actions?.(item, () => void q.refetch())}</div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-4">
          <Card title="Details">
            <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
              {ent.fields
                .filter((f) => f.key in item)
                .map((f) => (
                  <div key={f.key} className="contents">
                    <dt className="text-muted">{f.label}</dt>
                    <dd>{formatValue(f, item[f.key], props.meta.config.currency)}</dd>
                  </div>
                ))}
              {custom.map((c) => (
                <div key={c.key} className="contents">
                  <dt className="text-muted">{c.label}</dt>
                  <dd>{formatValue({ type: c.type === 'select' ? 'text' : c.type }, item.custom?.[c.key])}</dd>
                </div>
              ))}
              <dt className="text-muted">Version</dt>
              <dd>{item.version}</dd>
            </dl>
          </Card>
          {props.extra?.(item)}
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
    </>
  );
}

export async function runCommand(app: string, command: string, input: unknown, key?: string) {
  return api(`/api/apps/${app}/commands/${command}`, { body: input, headers: { 'Idempotency-Key': key ?? `ui-${crypto.randomUUID()}` } });
}
