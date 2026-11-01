import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { can, useMe } from '../components/shell';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, ModalDialog, PageHeader, Select, TextField } from '../components/ui';
import { api, ApiError, dateTime } from '../lib/api';

type Tab = 'endpoints' | 'dlq' | 'connectors' | 'syncs' | 'api';

export function HubScreen() {
  const me = useMe();
  const [tab, setTab] = useState<Tab>('endpoints');
  if (!can(me.data, 'platform:hub.read')) return <EmptyState title="Integration Hub">Ask an Admin for access to the Integration Hub.</EmptyState>;
  return (
    <>
      <PageHeader title="Integration Hub" description="Send events to your systems, sync records both ways, and give other systems API access." />
      <div role="group" aria-label="Sections" className="mb-4 flex flex-wrap gap-2">
        {(
          [
            ['endpoints', 'Endpoints'],
            ['dlq', 'Dead letters'],
            ['connectors', 'Connectors'],
            ['syncs', 'Two-way sync'],
            ['api', 'API access'],
          ] as const
        ).map(([k, l]) => (
          <Button key={k} variant={tab === k ? 'primary' : 'secondary'} aria-pressed={tab === k} onPress={() => setTab(k)}>
            {l}
          </Button>
        ))}
      </div>
      {tab === 'endpoints' && <EndpointsPanel />}
      {tab === 'dlq' && <DeadLettersPanel />}
      {tab === 'connectors' && <ConnectorsPanel />}
      {tab === 'syncs' && <SyncsPanel />}
      {tab === 'api' && <ApiAccessPanel />}
    </>
  );
}

const useEndpoints = () => useQuery({ queryKey: ['hub-endpoints'], queryFn: () => api('/api/hub/endpoints'), refetchInterval: 3000 });

function EndpointsPanel() {
  const me = useMe();
  const eps = useEndpoints();
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  return (
    <>
      {secret && (
        <div className="mb-4">
          <Alert tone="info" title="Signing secret — copy it now, it is shown once">
            <code className="break-all" data-testid="signing-secret">
              {secret}
            </code>
            <p className="mt-1">Verify the webhook-signature header with it (Standard Webhooks).</p>
          </Alert>
        </div>
      )}
      <Card title="Endpoints">
        {can(me.data, 'platform:hub.manage') && (
          <Button className="mb-3" onPress={() => setOpen(true)}>
            New endpoint
          </Button>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Endpoints</caption>
            <thead className="text-muted">
              <tr>
                <th scope="col" className="py-2 font-medium">Name</th>
                <th scope="col" className="py-2 font-medium">Kind</th>
                <th scope="col" className="py-2 font-medium">Events</th>
                <th scope="col" className="py-2 font-medium">Status</th>
                <th scope="col" className="py-2 font-medium">Circuit</th>
                <th scope="col" className="py-2 font-medium">Deliveries</th>
              </tr>
            </thead>
            <tbody>
              {(eps.data?.endpoints ?? []).map((e: any) => (
                <tr key={e.id} className="border-t border-line">
                  <td className="py-2">
                    <Link to={`/integration-hub/endpoints/${e.id}`} className="inline-flex min-h-11 items-center font-medium text-accent underline">
                      {e.name}
                    </Link>
                  </td>
                  <td className="py-2">{e.kind}</td>
                  <td className="py-2">{e.event_types.join(', ')}</td>
                  <td className="py-2">
                    <Badge value={e.status} />
                  </td>
                  <td className="py-2">
                    <Badge value={e.circuit_state === 'closed' ? 'active' : e.circuit_state} />
                  </td>
                  <td className="py-2">{Object.entries(e.stats).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {eps.data?.endpoints?.length === 0 && <p className="text-muted">No endpoints yet.</p>}
      </Card>
      {open && <EndpointDialog onClose={() => setOpen(false)} onCreated={(s) => setSecret(s)} />}
    </>
  );
}

const KINDS = [
  { id: 'webhook', label: 'Webhook (signed)' },
  { id: 'rest_push', label: 'REST push' },
  { id: 'kafka', label: 'Kafka topic' },
  { id: 'redis_stream', label: 'Redis Stream' },
  { id: 'sftp', label: 'SFTP drop' },
  { id: 'sqs', label: 'Amazon SQS queue' },
  { id: 'custom', label: 'Custom connector' },
];

function EndpointDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (secret: string | null) => void }) {
  const qc = useQueryClient();
  const events = useQuery({ queryKey: ['hub-events'], queryFn: () => api('/api/hub/events') });
  const connectors = useQuery({ queryKey: ['hub-connectors'], queryFn: () => api('/api/hub/connectors') });
  const [kind, setKind] = useState('webhook');
  const [f, setF] = useState({ name: '', event_types: '', filter: '', url: '', method: 'POST', token: '', brokers: '', topic: '', username: '', password: '', stream: '', host: '', directory: '/inbox', queue_url: '', region: 'ap-southeast-1', access_key_id: '', secret_access_key: '', connector_id: '' });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const config: Record<string, unknown> =
      kind === 'webhook'
        ? { url: f.url }
        : kind === 'rest_push'
          ? { url: f.url, method: f.method }
          : kind === 'kafka'
            ? { brokers: f.brokers.split(',').map((s) => s.trim()).filter(Boolean), topic: f.topic }
            : kind === 'redis_stream'
              ? { url: f.url, stream: f.stream }
              : kind === 'sftp'
                ? { host: f.host, directory: f.directory }
                : kind === 'sqs'
                  ? { queue_url: f.queue_url, region: f.region }
                  : { connector_id: f.connector_id };
    const credentials =
      kind === 'rest_push' && f.token
        ? { type: 'bearer', token: f.token }
        : kind === 'kafka' && f.username
          ? { mechanism: 'scram-sha-256', username: f.username, password: f.password }
          : kind === 'redis_stream' && f.password
            ? { password: f.password }
            : kind === 'sftp' && f.username
              ? { username: f.username, password: f.password }
              : kind === 'sqs' && f.access_key_id
                ? { access_key_id: f.access_key_id, secret_access_key: f.secret_access_key }
                : undefined;
    try {
      const r = await api('/api/hub/endpoints', {
        body: { kind, name: f.name, event_types: f.event_types.split(',').map((s) => s.trim()).filter(Boolean), ...(f.filter ? { filter: f.filter } : {}), config, ...(credentials ? { credentials } : {}) },
      });
      onCreated(r.signingSecret);
      await qc.invalidateQueries({ queryKey: ['hub-endpoints'] });
      onClose();
    } catch (err) {
      setError((err as ApiError).message);
    }
  };
  return (
    <ModalDialog title="New endpoint" isOpen onOpenChange={(o) => !o && onClose()}>
      <form onSubmit={submit} className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto">
        <TextField label="Name" value={f.name} onChange={set('name')} isRequired />
        <Select label="Kind" value={kind} onChange={setKind} options={KINDS} />
        <TextField label="Event types (comma separated)" value={f.event_types} onChange={set('event_types')} description={`e.g. order.created, record.*, ${(events.data?.types ?? []).slice(0, 3).map((t: any) => t.type).join(', ')}`} isRequired />
        <TextField label="Filter (optional)" value={f.filter} onChange={set('filter')} placeholder="data.total > 100000" />
        {(kind === 'webhook' || kind === 'rest_push') && <TextField label="URL" value={f.url} onChange={set('url')} placeholder="https://…" isRequired />}
        {kind === 'rest_push' && (
          <>
            <Select label="Method" value={f.method!} onChange={set('method')} options={['POST', 'PUT', 'PATCH'].map((m) => ({ id: m, label: m }))} />
            <TextField label="Bearer token (write-only)" type="password" value={f.token!} onChange={set('token')} />
          </>
        )}
        {kind === 'kafka' && (
          <>
            <TextField label="Brokers (host:port, comma separated)" value={f.brokers!} onChange={set('brokers')} />
            <TextField label="Topic" value={f.topic!} onChange={set('topic')} />
          </>
        )}
        {kind === 'redis_stream' && (
          <>
            <TextField label="Redis URL" value={f.url} onChange={set('url')} placeholder="rediss://host:6380" />
            <TextField label="Stream" value={f.stream!} onChange={set('stream')} />
          </>
        )}
        {kind === 'sftp' && (
          <>
            <TextField label="Host" value={f.host!} onChange={set('host')} />
            <TextField label="Directory" value={f.directory!} onChange={set('directory')} />
          </>
        )}
        {kind === 'sqs' && (
          <>
            <TextField label="Queue URL" value={f.queue_url!} onChange={set('queue_url')} />
            <TextField label="Region" value={f.region!} onChange={set('region')} />
            <TextField label="Access key id (write-only)" value={f.access_key_id!} onChange={set('access_key_id')} />
            <TextField label="Secret access key (write-only)" type="password" value={f.secret_access_key!} onChange={set('secret_access_key')} />
          </>
        )}
        {(kind === 'kafka' || kind === 'sftp') && (
          <>
            <TextField label="Username (write-only)" value={f.username!} onChange={set('username')} />
            <TextField label="Password (write-only)" type="password" value={f.password!} onChange={set('password')} />
          </>
        )}
        {kind === 'redis_stream' && <TextField label="Password (write-only)" type="password" value={f.password!} onChange={set('password')} />}
        {kind === 'custom' && <Select label="Connector" value={f.connector_id || null} onChange={set('connector_id')} options={(connectors.data?.connectors ?? []).map((c: any) => ({ id: c.id, label: c.name }))} />}
        <p className="text-sm text-muted">Private and internal network addresses are refused. Credentials are encrypted and never shown again.</p>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button type="submit">Create endpoint</Button>
        </div>
      </form>
    </ModalDialog>
  );
}

export function EndpointScreen() {
  const { id } = useParams({ strict: false }) as { id: string };
  const me = useMe();
  const qc = useQueryClient();
  const eps = useEndpoints();
  const [status, setStatus] = useState<string>('all');
  const d = useQuery({ queryKey: ['hub-deliveries', id, status], queryFn: () => api(`/api/hub/endpoints/${id}/deliveries${status === 'all' ? '' : `?status=${status}`}`), refetchInterval: 2000 });
  const [msg, setMsg] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);
  const ep = (eps.data?.endpoints ?? []).find((e: any) => e.id === id);
  const manage = can(me.data, 'platform:hub.manage');
  const act = async (fn: () => Promise<any>, ok: (r: any) => string) => {
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ tone: 'success', text: ok(r) });
    } catch (e) {
      setMsg({ tone: 'error', text: (e as ApiError).message });
    }
    await qc.invalidateQueries({ queryKey: ['hub-deliveries', id] });
    await qc.invalidateQueries({ queryKey: ['hub-endpoints'] });
  };
  if (!ep) return <p className="text-muted">Loading…</p>;
  return (
    <>
      <PageHeader
        title={ep.name}
        description={
          <>
            {ep.kind} · {ep.event_types.join(', ')} · circuit {ep.circuit_state} · schema pins {Object.entries(ep.schema_pins).map(([k, v]) => `${k}@v${v}`).join(', ')}
          </>
        }
        actions={
          manage && (
            <>
              <Button variant="secondary" onPress={() => act(() => api(`/api/hub/endpoints/${id}/status`, { body: { status: ep.status === 'active' ? 'paused' : 'active' } }), () => 'Updated.')}>
                {ep.status === 'active' ? 'Pause' : 'Resume'}
              </Button>
              <Button variant="secondary" onPress={() => act(() => api('/api/hub/replay', { body: { endpointId: id } }), (r) => `Replaying ${r.replayed} dead deliveries.`)}>
                Replay all dead
              </Button>
              {ep.kind === 'webhook' && (
                <Button variant="ghost" onPress={() => act(() => api(`/api/hub/endpoints/${id}/rotate-secret`, { body: {} }), (r) => `New signing secret (shown once): ${r.signingSecret}`)}>
                  Rotate secret
                </Button>
              )}
            </>
          )
        }
      />
      {msg && (
        <div className="mb-4">
          <Alert tone={msg.tone}>{msg.text}</Alert>
        </div>
      )}
      <div className="mb-3 max-w-xs">
        <Select label="Show" value={status} onChange={setStatus} options={['all', 'pending', 'succeeded', 'dead', 'skipped'].map((s) => ({ id: s, label: s }))} />
      </div>
      <Card title="Delivery log">
        <ul className="flex flex-col gap-3 text-sm" aria-label="Deliveries">
          {(d.data?.deliveries ?? []).map((x: any) => (
            <li key={x.id} className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <code>{x.event_type}</code> · event <code>{x.event_id.slice(0, 8)}</code> · <Badge value={x.status} /> · {x.attempts} attempt{x.attempts === 1 ? '' : 's'}
                  {x.replays ? ` · replayed ${x.replays}×` : ''}
                </span>
                {manage && ['dead', 'skipped', 'succeeded'].includes(x.status) && (
                  <Button variant="ghost" onPress={() => act(() => api('/api/hub/replay', { body: { ids: [x.id] } }), () => 'Replay queued.')} aria-label={`Replay delivery ${x.event_id.slice(0, 8)}`}>
                    Replay
                  </Button>
                )}
              </div>
              {x.last_error && <p className="text-bad">{x.last_error}</p>}
              {x.status === 'pending' && x.attempts > 0 && <p className="text-muted">Next attempt {dateTime(x.next_attempt_at)}</p>}
              {x.attempts_log.length > 0 && (
                <ol className="mt-1 text-muted">
                  {x.attempts_log.map((a: any) => (
                    <li key={a.id}>
                      #{a.attempt} {dateTime(a.at)} · {a.ok ? 'ok' : 'failed'} {a.status_code ?? ''} {a.error ? `· ${a.error}` : ''} · {a.duration_ms} ms
                    </li>
                  ))}
                </ol>
              )}
            </li>
          ))}
          {d.data?.deliveries?.length === 0 && <li className="text-muted">No deliveries.</li>}
        </ul>
      </Card>
    </>
  );
}

function DeadLettersPanel() {
  const eps = useEndpoints();
  const withDead = (eps.data?.endpoints ?? []).filter((e: any) => e.stats.dead);
  return (
    <Card title="Dead letter queue">
      {withDead.length === 0 ? (
        <p className="text-muted">No dead deliveries.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {withDead.map((e: any) => (
            <li key={e.id} className="flex min-h-11 items-center justify-between">
              <span>
                {e.name}: {e.stats.dead} dead
              </span>
              <Link to={`/integration-hub/endpoints/${e.id}`} className="font-medium text-accent underline">
                Review and replay
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const SAMPLE = JSON.stringify(
  {
    description: 'Shape orders for the ERP',
    steps: [
      { kind: 'map', fields: { number: 'data.number', total: 'data.total' } },
      { kind: 'code', source: 'function transform(input) {\n  return { orderNo: "ORD-" + input.number, cents: input.total * 100 };\n}' },
      { kind: 'http', url: 'https://erp.example.com/orders', method: 'POST' },
    ],
  },
  null,
  2,
);

function ConnectorsPanel() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['hub-connectors'], queryFn: () => api('/api/hub/connectors') });
  const [name, setName] = useState('');
  const [spec, setSpec] = useState(SAMPLE);
  const [out, setOut] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const parsed = () => {
    try {
      return JSON.parse(spec);
    } catch {
      throw new Error('spec is not valid JSON');
    }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Connectors">
        <ul className="text-sm">
          {(list.data?.connectors ?? []).map((c: any) => (
            <li key={c.id} className="min-h-11">
              {c.name} · {c.spec.steps.map((s: any) => s.kind).join(' → ')}
            </li>
          ))}
          {list.data?.connectors?.length === 0 && <li className="text-muted">No connectors.</li>}
        </ul>
      </Card>
      <Card title="New connector">
        <div className="flex flex-col gap-3">
          <TextField label="Name" value={name} onChange={setName} />
          <label className="flex flex-col gap-1 text-sm font-medium">
            Spec (JSON: map, code and http steps)
            <textarea className="min-h-64 rounded-lg border border-line bg-white p-3 font-mono text-sm" value={spec} onChange={(e) => setSpec(e.target.value)} spellCheck={false} />
          </label>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onPress={async () => {
                setError(null);
                try {
                  setOut(JSON.stringify(await api('/api/hub/connectors/test', { body: { spec: parsed() } }), null, 2));
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Dry run
            </Button>
            <Button
              onPress={async () => {
                setError(null);
                try {
                  await api('/api/hub/connectors', { body: { name, spec: parsed() } });
                  await qc.invalidateQueries({ queryKey: ['hub-connectors'] });
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Save connector
            </Button>
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          {out && <pre className="max-h-64 overflow-auto rounded-lg bg-ground p-3 text-xs">{out}</pre>}
          <p className="text-sm text-muted">Code runs in an isolated V8 sandbox with a memory cap and a time limit; it has no network or file access.</p>
        </div>
      </Card>
    </div>
  );
}

function SyncsPanel() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['hub-syncs'], queryFn: () => api('/api/hub/syncs') });
  const eps = useEndpoints();
  const model = useQuery({ queryKey: ['data-model'], queryFn: () => api('/api/data-model') });
  const [f, setF] = useState({ name: '', entity: '', endpoint_id: '', conflict_rule: 'platform_wins', field_map: '{}' });
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Syncs">
        <ul className="flex flex-col gap-2 text-sm">
          {(list.data?.syncs ?? []).map((s: any) => (
            <li key={s.id} className="rounded-lg border border-line p-3">
              <p className="font-medium">
                {s.name} · {s.entity} · {s.conflict_rule.replace(/_/g, ' ')} · {s.mapped} mapped
              </p>
              <p className="break-all text-muted">Inbound: POST {s.inbound_url}</p>
            </li>
          ))}
          {list.data?.syncs?.length === 0 && <li className="text-muted">No syncs.</li>}
        </ul>
      </Card>
      <Card title="New two-way sync">
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await api('/api/hub/syncs', { body: { name: f.name, entity: f.entity, conflict_rule: f.conflict_rule, field_map: JSON.parse(f.field_map || '{}'), ...(f.endpoint_id ? { endpoint_id: f.endpoint_id } : {}) } });
              await qc.invalidateQueries({ queryKey: ['hub-syncs'] });
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <TextField label="Name" value={f.name} onChange={(v) => setF({ ...f, name: v })} />
          <Select label="Custom entity" value={f.entity || null} onChange={(v) => setF({ ...f, entity: v })} options={(model.data?.entities ?? []).map((e: any) => ({ id: e.key, label: e.label }))} />
          <Select label="Outbound endpoint" value={f.endpoint_id || null} onChange={(v) => setF({ ...f, endpoint_id: v })} options={(eps.data?.endpoints ?? []).filter((e: any) => ['webhook', 'rest_push'].includes(e.kind)).map((e: any) => ({ id: e.id, label: e.name }))} />
          <Select label="When both sides changed" value={f.conflict_rule} onChange={(v) => setF({ ...f, conflict_rule: v })} options={[{ id: 'platform_wins', label: 'Keep our change' }, { id: 'remote_wins', label: 'Take their change' }, { id: 'last_write_wins', label: 'Latest change wins' }]} />
          <TextField label="Field map (JSON, our field → their field)" value={f.field_map} onChange={(v) => setF({ ...f, field_map: v })} />
          {error && <Alert tone="error">{error}</Alert>}
          <Button type="submit">Create sync</Button>
        </form>
      </Card>
    </div>
  );
}

function ApiAccessPanel() {
  const me = useMe();
  const qc = useQueryClient();
  const manage = can(me.data, 'platform:apikeys.manage');
  const access = useQuery({ queryKey: ['api-access'], queryFn: () => api('/api/api-access'), enabled: manage });
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => api('/api/tokens') });
  const scopes = Object.entries((access.data?.scopes ?? tokens.data?.scopes ?? {}) as Record<string, string>);
  const [name, setName] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set(['records:read']));
  const [shown, setShown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = async (path: string, body: object, show: (r: any) => string) => {
    setError(null);
    try {
      setShown(show(await api(path, { body })));
      await qc.invalidateQueries({ queryKey: ['api-access'] });
      await qc.invalidateQueries({ queryKey: ['tokens'] });
    } catch (e) {
      setError((e as ApiError).message);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      {shown && (
        <Alert tone="info" title="Copy it now — it is shown once">
          <code className="break-all" data-testid="new-credential">
            {shown}
          </code>
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      <Card title="Create a credential">
        <div className="flex flex-col gap-3">
          <TextField label="Name" value={name} onChange={setName} />
          <fieldset>
            <legend className="text-sm font-semibold">Scopes</legend>
            {scopes.map(([s, desc]) => (
              <Checkbox key={s} isSelected={sel.has(s)} onChange={(v) => setSel((x) => { const n = new Set(x); if (v) n.add(s); else n.delete(s); return n; })}>
                <code>{s}</code> — {desc}
              </Checkbox>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            {manage && (
              <>
                <Button isDisabled={!name || !sel.size} onPress={() => create('/api/api-keys', { name, scopes: [...sel] }, (r) => r.key)}>
                  Create API key
                </Button>
                <Button variant="secondary" isDisabled={!name || !sel.size} onPress={() => create('/api/oauth-clients', { name, scopes: [...sel] }, (r) => `client_id: ${r.client_id}  client_secret: ${r.client_secret}`)}>
                  Create OAuth client
                </Button>
              </>
            )}
            <Button variant="secondary" isDisabled={!name || !sel.size} onPress={() => create('/api/tokens', { name, scopes: [...sel], expires_in_minutes: 60 }, (r) => r.token)}>
              Create delegated token (acts as you, 1 hour)
            </Button>
          </div>
          {access.data && (
            <p className="text-sm text-muted">
              Token URL <code>{access.data.tokenUrl}</code> · OpenAPI <code>{access.data.openapiUrl}</code>
            </p>
          )}
        </div>
      </Card>
      {manage && access.data && (
        <Card title="API keys and OAuth clients">
          <ul className="text-sm">
            {[...access.data.keys.map((k: any) => ({ ...k, kind: 'keys', label: `API key …${k.hint}` })), ...access.data.clients.map((c: any) => ({ ...c, kind: 'clients', label: 'OAuth client' }))].map((c: any) => (
              <li key={c.id} className="flex min-h-11 items-center justify-between gap-2">
                <span>
                  {c.name} · {c.label} · {c.scopes.join(' ')} {c.revoked_at ? '· revoked' : ''}
                </span>
                {!c.revoked_at && (
                  <Button variant="ghost" onPress={() => create(`/api/api-access/${c.kind}/${c.id}/revoke`, {}, () => `${c.name} revoked.`)}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
