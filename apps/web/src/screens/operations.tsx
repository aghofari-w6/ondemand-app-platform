import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { can, useMe } from '../components/shell';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, TextArea, TextField } from '../components/ui';
import { api, ApiError, dateTime } from '../lib/api';

// ------------------------------------------------------------------ Approvals inbox

type ApprovalTab = 'pending' | 'decided';

export function ApprovalsScreen() {
  const [tab, setTab] = useState<ApprovalTab>('pending');
  const list = useQuery({ queryKey: ['approvals', tab], queryFn: () => api(`/api/approvals?status=${tab}`), refetchInterval: 4000 });
  const requests = (list.data?.requests ?? []) as any[];
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Approvals" description="Requests from workflows (and, later, the assistant) that need a decision from your role." />
      <div aria-live="polite" className="mb-4 empty:hidden">
        {notice && <Alert tone="success">{notice}</Alert>}
      </div>
      <div role="group" aria-label="Show" className="mb-4 flex gap-2">
        <Button variant={tab === 'pending' ? 'primary' : 'secondary'} aria-pressed={tab === 'pending'} onPress={() => setTab('pending')}>
          Waiting for a decision
        </Button>
        <Button variant={tab === 'decided' ? 'primary' : 'secondary'} aria-pressed={tab === 'decided'} onPress={() => setTab('decided')}>
          Decided
        </Button>
      </div>
      {requests.length === 0 && list.data && <EmptyState title={tab === 'pending' ? 'Nothing to approve' : 'No decided requests'}>Requests addressed to your role appear here.</EmptyState>}
      <ul className="flex flex-col gap-4">
        {requests.map((r) => (
          <li key={r.id}>
            <ApprovalCard request={r} onDecided={setNotice} />
          </li>
        ))}
      </ul>
    </>
  );
}

function ApprovalCard({ request: r, onDecided }: { request: any; onDecided: (text: string) => void }) {
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  const [msg, setMsg] = useState<{ tone: 'error'; text: string } | null>(null);
  const decide = async (decision: 'approve' | 'reject') => {
    try {
      const res = await api<{ status: string; approvals: number; quorum: number }>(`/api/approvals/${r.id}/decide`, { body: { decision, comment } });
      // Shown by the screen: a resolved request leaves the pending list.
      onDecided(res.status === 'pending' ? `“${r.title}”: recorded, ${res.approvals} of ${res.quorum} approvals.` : `“${r.title}”: request ${res.status}.`);
      await qc.invalidateQueries({ queryKey: ['approvals'] });
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof ApiError ? e.message : String(e) });
    }
  };
  return (
    <Card as="div">
      <article aria-labelledby={`appr-${r.id}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 id={`appr-${r.id}`} className="text-base font-semibold">
            {r.title}
          </h2>
          <Badge value={r.status} />
        </div>
        {r.details && <p className="mt-1 whitespace-pre-wrap text-sm">{r.details}</p>}
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Approvers</dt>
          <dd>{(r.approver_roles as string[]).join(', ')}</dd>
          <dt className="text-muted">Approvals</dt>
          <dd>
            {r.approvals} of {r.quorum} needed
          </dd>
          <dt className="text-muted">Requested</dt>
          <dd>
            {dateTime(r.created_at)} by {r.source}
          </dd>
          <dt className="text-muted">Expires</dt>
          <dd>{dateTime(r.expires_at)}</dd>
        </dl>
        {r.decisions.length > 0 && (
          <ul className="mt-2 text-sm">
            {r.decisions.map((d: any) => (
              <li key={d.user_id}>
                {d.name} {d.decision === 'approve' ? 'approved' : 'rejected'} · {dateTime(d.at)}
                {d.comment ? ` — “${d.comment}”` : ''}
              </li>
            ))}
          </ul>
        )}
        {r.correlation_id && (
          <Link to={`/trace-viewer?q=${encodeURIComponent(r.correlation_id)}`} className="inline-flex min-h-11 items-center text-sm text-accent underline">
            See what led to this request
          </Link>
        )}
        {r.can_decide && (
          <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
            <TextArea label={`Comment on “${r.title}” (optional)`} rows={2} value={comment} onChange={setComment} />
            <div className="flex gap-2">
              <Button onPress={() => decide('approve')}>Approve</Button>
              <Button variant="danger" onPress={() => decide('reject')}>
                Reject
              </Button>
            </div>
          </div>
        )}
        {msg && (
          <div className="mt-3">
            <Alert tone={msg.tone}>{msg.text}</Alert>
          </div>
        )}
      </article>
    </Card>
  );
}

// ------------------------------------------------------------------ Trace viewer

const KIND_LABEL: Record<string, string> = {
  audit: 'Command / change',
  event: 'Event',
  consumer: 'Consumer',
  run: 'Workflow run',
  node: 'Workflow node',
  delivery: 'Hub delivery',
  approval: 'Approval',
  decision: 'Decision',
};

export function TraceViewerScreen() {
  const me = useMe();
  const navigate = useNavigate();
  const initial = typeof window !== 'undefined' ? (new URLSearchParams(window.location.search).get('q') ?? '') : '';
  const [input, setInput] = useState(initial);
  const [q, setQ] = useState(initial);
  const trace = useQuery({ queryKey: ['trace', q], queryFn: () => api(`/api/trace?q=${encodeURIComponent(q)}`), enabled: Boolean(q) && can(me.data, 'platform:trace.read') });
  if (!can(me.data, 'platform:trace.read')) return <EmptyState title="Trace viewer">Ask a Manager or Admin for access to the trace viewer.</EmptyState>;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setQ(input.trim());
    void navigate({ to: `/trace-viewer?q=${encodeURIComponent(input.trim())}`, replace: true });
  };
  const items = (trace.data?.items ?? []) as any[];
  return (
    <>
      <PageHeader title="Trace viewer" description="Follow one change from the command through its events, consumers, workflows, Hub deliveries and approvals." />
      <form onSubmit={submit} role="search" className="mb-4 flex flex-wrap items-end gap-2">
        <TextField className="min-w-72 flex-1" label="Correlation id, event id, record id or run id" value={input} onChange={setInput} />
        <Button type="submit" isDisabled={!input.trim()}>
          Trace
        </Button>
      </form>
      {trace.error && <Alert tone="error">{(trace.error as Error).message}</Alert>}
      {trace.data && (
        <Card title={`Timeline (${items.length})`}>
          <p className="mb-3 text-sm text-muted">Correlation: {trace.data.correlation_ids.join(', ')}</p>
          {items.length === 0 && <p className="text-muted">Nothing found for this id.</p>}
          <ol className="relative flex flex-col gap-3 border-l-2 border-line pl-4" aria-label="Trace timeline">
            {items.map((it, i) => (
              <li key={i} className="text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <time dateTime={it.at} className="text-muted">
                    {new Date(it.at).toLocaleTimeString('en-GB', { hour12: false })}.{String(new Date(it.at).getMilliseconds()).padStart(3, '0')}
                  </time>
                  <span className="rounded bg-ground px-1.5 py-0.5 text-xs font-medium">{KIND_LABEL[it.kind] ?? it.kind}</span>
                  <span className="font-medium">{it.title}</span>
                  {it.status && <Badge value={it.status} />}
                </p>
                {it.detail && <p className="text-muted">{it.detail}</p>}
                <p className="flex flex-wrap gap-x-3 text-xs text-muted">
                  {it.ids.event_id && <span>event {it.ids.event_id}</span>}
                  {it.ids.causation_id && <span>caused by {it.ids.causation_id}</span>}
                  {it.traceparent && <span>traceparent {it.traceparent}</span>}
                </p>
                {it.ids.run_id && it.kind === 'run' && (
                  <Link to={`/workflow-runs/${it.ids.run_id}`} className="inline-flex min-h-11 items-center text-accent underline">
                    Open execution view
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </Card>
      )}
    </>
  );
}
