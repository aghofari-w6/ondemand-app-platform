import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { can, useMe } from '../components/shell';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Select, TextField } from '../components/ui';
import { api, ApiError, dateTime } from '../lib/api';

type Tab = 'pii' | 'access' | 'retention' | 'dsr' | 'audit';
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

export function DataGovernanceScreen() {
  const me = useMe();
  const [tab, setTab] = useState<Tab>('pii');
  if (!can(me.data, 'platform:governance.read')) return <EmptyState title="Data governance">Ask an Admin for access to data governance.</EmptyState>;
  return (
    <>
      <PageHeader title="Data governance" description="Where personal data lives, who can read it, how long it is kept, and requests from the people it is about." />
      <div role="group" aria-label="Sections" className="mb-4 flex flex-wrap gap-2">
        {(
          [
            ['pii', 'PII inventory'],
            ['access', 'Access review'],
            ['retention', 'Retention'],
            ['dsr', 'Data subject requests'],
            ['audit', 'Audit-log export'],
          ] as const
        ).map(([k, l]) => (
          <Button key={k} variant={tab === k ? 'primary' : 'secondary'} aria-pressed={tab === k} onPress={() => setTab(k)}>
            {l}
          </Button>
        ))}
      </div>
      {tab === 'pii' && <PiiPanel />}
      {tab === 'access' && <AccessPanel />}
      {tab === 'retention' && <RetentionPanel />}
      {tab === 'dsr' && <DsrPanel />}
      {tab === 'audit' && <AuditPanel />}
    </>
  );
}

interface PiiField {
  target: string;
  field: string;
  label: string;
  source: string;
  storage: string;
  encrypted: boolean;
}

function PiiPanel() {
  const pii = useQuery<{ fields: PiiField[] }>({ queryKey: ['gov-pii'], queryFn: () => api('/api/governance/pii') });
  return (
    <Card title="Personal data fields">
      <p className="mb-3 text-sm text-muted">From app manifests (fields marked PII) and Data studio (fields you marked PII, encrypted at rest).</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">PII inventory</caption>
          <thead className="text-muted">
            <tr>
              <th scope="col" className="py-2 font-medium">Field</th>
              <th scope="col" className="py-2 font-medium">Where</th>
              <th scope="col" className="py-2 font-medium">Defined in</th>
              <th scope="col" className="py-2 font-medium">At rest</th>
            </tr>
          </thead>
          <tbody>
            {(pii.data?.fields ?? []).map((f) => (
              <tr key={`${f.target}.${f.field}`} className="border-t border-line">
                <td className="py-2">{f.label}</td>
                <td className="py-2">
                  <code>{f.target}</code> · <code>{f.field}</code>
                </td>
                <td className="py-2">{f.source}</td>
                <td className="py-2">{f.encrypted ? 'Encrypted' : 'Plain column'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pii.data?.fields.length === 0 && <p className="text-muted">No personal data fields in this workspace.</p>}
    </Card>
  );
}

function AccessPanel() {
  const review = useQuery<{ fields: (PiiField & { roles: { role: string; name: string; access: string }[]; credentials: { kind: string; id: string; name: string }[] })[] }>({ queryKey: ['gov-access'], queryFn: () => api('/api/governance/access-review') });
  return (
    <Card title="Who can read each personal data field">
      <p className="mb-3 text-sm text-muted">Roles after field rules. API keys and OAuth clients see every field their scopes allow; delegated tokens are limited to their user's role.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Access review</caption>
          <thead className="text-muted">
            <tr>
              <th scope="col" className="py-2 font-medium">Field</th>
              <th scope="col" className="py-2 font-medium">Roles</th>
              <th scope="col" className="py-2 font-medium">API credentials</th>
            </tr>
          </thead>
          <tbody>
            {(review.data?.fields ?? []).map((f) => (
              <tr key={`${f.target}.${f.field}`} className="border-t border-line align-top">
                <td className="py-2">{f.label}</td>
                <td className="py-2">{f.roles.map((r) => `${r.name}${r.access === 'read' ? ' (read only)' : ''}`).join(', ') || 'None'}</td>
                <td className="py-2">{f.credentials.map((c) => `${c.name} (${c.kind})`).join(', ') || 'None'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function RetentionPanel() {
  const me = useMe();
  const qc = useQueryClient();
  const pii = useQuery<{ fields: PiiField[] }>({ queryKey: ['gov-pii'], queryFn: () => api('/api/governance/pii') });
  const pol = useQuery<{ policies: any[] }>({ queryKey: ['gov-retention'], queryFn: () => api('/api/governance/retention') });
  const targets = [...new Set((pii.data?.fields ?? []).map((f) => f.target))];
  const [target, setTarget] = useState<string>('');
  const [action, setAction] = useState('anonymise');
  const [days, setDays] = useState('365');
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const manage = can(me.data, 'platform:governance.manage');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      await api('/api/governance/retention', { body: { target: target || targets[0], action, after_days: Number(days) } });
      setMsg({ tone: 'success', text: 'Policy saved. It runs every night; you can also run it now.' });
      await qc.invalidateQueries({ queryKey: ['gov-retention'] });
    } catch (err) {
      setMsg({ tone: 'error', text: errorText(err) });
    }
  };
  const runNow = async (id: string, label: string) => {
    setMsg(null);
    try {
      const r = await api<{ results: { records: number }[] }>(`/api/governance/retention/${id}/run`, { body: {} });
      setMsg({ tone: 'success', text: `${label}: ${r.results[0]?.records ?? 0} record(s) processed.` });
      await qc.invalidateQueries({ queryKey: ['gov-retention'] });
    } catch (err) {
      setMsg({ tone: 'error', text: errorText(err) });
    }
  };
  return (
    <>
      <div aria-live="polite" className="mb-4 empty:hidden">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      </div>
      <Card title="Retention policies">
        <ul className="flex flex-col divide-y divide-line">
          {(pol.data?.policies ?? []).map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <div>
                <p className="font-medium">
                  {p.action === 'anonymise' ? 'Anonymise' : 'Delete'} <code>{p.target}</code> after {p.after_days} days {!p.enabled && <Badge value="disabled" />}
                </p>
                <p className="text-sm text-muted">{p.last_run_at ? `Last run ${dateTime(p.last_run_at)}: ${p.last_result?.records ?? 0} record(s)` : 'Not run yet'}</p>
              </div>
              {manage && (
                <Button variant="secondary" onPress={() => runNow(p.id, p.target)}>
                  Run now<span className="sr-only">: {p.target}</span>
                </Button>
              )}
            </li>
          ))}
        </ul>
        {pol.data?.policies.length === 0 && <p className="text-muted">No policies yet.</p>}
        {manage && (
          <form onSubmit={save} className="mt-4 grid items-end gap-3 border-t border-line pt-4 sm:grid-cols-4">
            <Select label="Data" value={target || targets[0] || null} onChange={setTarget} options={targets.map((t) => ({ id: t, label: t }))} />
            <Select label="Action" value={action} onChange={setAction} options={[{ id: 'anonymise', label: 'Anonymise personal data' }, { id: 'purge', label: 'Delete records (custom data only)' }]} />
            <TextField label="After (days)" value={days} onChange={setDays} inputMode="numeric" />
            <Button type="submit" isDisabled={!targets.length}>
              Save policy
            </Button>
          </form>
        )}
      </Card>
    </>
  );
}

function DsrPanel() {
  const me = useMe();
  const qc = useQueryClient();
  const list = useQuery<{ requests: any[] }>({ queryKey: ['gov-dsr'], queryFn: () => api('/api/governance/dsr') });
  const [kind, setKind] = useState('export');
  const [subject, setSubject] = useState('');
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string; link?: string | null } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      const r = await api<{ found: unknown[]; download_url: string | null }>('/api/governance/dsr', { body: { kind, subject } });
      setMsg({ tone: 'success', text: kind === 'export' ? `Found ${r.found.length} record(s). The export is ready.` : `Erased personal data from ${r.found.length} record(s). Amounts and the audit log are kept.`, link: r.download_url });
      setSubject('');
      await qc.invalidateQueries({ queryKey: ['gov-dsr'] });
    } catch (err) {
      setMsg({ tone: 'error', text: errorText(err) });
    }
  };
  return (
    <>
      <div aria-live="polite" className="mb-4 empty:hidden">
        {msg && (
          <Alert tone={msg.tone}>
            {msg.text}{' '}
            {msg.link && (
              <a href={msg.link} className="inline-flex min-h-11 items-center font-medium underline">
                Download the export
              </a>
            )}
          </Alert>
        )}
      </div>
      {can(me.data, 'platform:governance.manage') && (
        <Card title="New request" className="mb-4">
          <form onSubmit={submit} className="grid items-end gap-3 sm:grid-cols-[1fr_2fr_auto]">
            <Select label="Request" value={kind} onChange={setKind} options={[{ id: 'export', label: 'Export their data' }, { id: 'erase', label: 'Erase their data' }]} />
            <TextField label="Email or phone of the person" value={subject} onChange={setSubject} description="Searched across apps and linked records. Stored encrypted." />
            <Button type="submit" variant={kind === 'erase' ? 'danger' : 'primary'} isDisabled={subject.trim().length < 5}>
              {kind === 'erase' ? 'Erase' : 'Export'}
            </Button>
          </form>
        </Card>
      )}
      <Card title="Requests">
        <ul className="flex flex-col divide-y divide-line">
          {(list.data?.requests ?? []).map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
              <span>
                {r.kind === 'export' ? 'Export' : 'Erase'} · {dateTime(r.created_at)} · <Badge value={r.status} /> · {r.found_count} record(s)
                {r.error && <span className="text-bad"> · {r.error}</span>}
              </span>
              {r.download_url && (
                <a href={r.download_url} className="inline-flex min-h-11 items-center text-accent underline">
                  Download<span className="sr-only"> the export from {dateTime(r.created_at)}</span>
                </a>
              )}
            </li>
          ))}
        </ul>
        {list.data?.requests.length === 0 && <p className="text-muted">No requests yet.</p>}
      </Card>
    </>
  );
}

function AuditPanel() {
  const me = useMe();
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string; link?: string | null } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      const end = new Date(`${to}T00:00:00Z`).getTime() + 86_400_000;
      const r = await api<{ rows: number; download_url: string }>('/api/governance/audit-export', { body: { from: new Date(`${from}T00:00:00Z`).toISOString(), to: new Date(end).toISOString() } });
      setMsg({ tone: 'success', text: `${r.rows} audit entries exported.`, link: r.download_url });
    } catch (err) {
      setMsg({ tone: 'error', text: errorText(err) });
    }
  };
  if (!can(me.data, 'platform:governance.manage')) return <EmptyState title="Audit-log export">Ask an Admin to export the audit log.</EmptyState>;
  return (
    <Card title="Export the audit log as CSV">
      <form onSubmit={submit} className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <TextField label="From (YYYY-MM-DD)" value={from} onChange={setFrom} />
        <TextField label="To, inclusive (YYYY-MM-DD)" value={to} onChange={setTo} />
        <Button type="submit">Export</Button>
      </form>
      <div aria-live="polite" className="mt-3 empty:hidden">
        {msg && (
          <Alert tone={msg.tone}>
            {msg.text}{' '}
            {msg.link && (
              <a href={msg.link} className="inline-flex min-h-11 items-center font-medium underline">
                Download CSV
              </a>
            )}
          </Alert>
        )}
      </div>
    </Card>
  );
}
