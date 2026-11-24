import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { can, useMe } from '../components/shell';
import { Alert, Badge, Button, Card, EmptyState, ModalDialog, PageHeader, Select, TextArea, TextField } from '../components/ui';
import { api, ApiError, dateTime } from '../lib/api';

/**
 * Inbox: customer conversations from every channel in one place. The list and the open
 * conversation update live through Server-Sent Events (with a slow refetch as a fallback).
 */

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));
const CHANNEL: Record<string, string> = { widget: 'Web chat', telegram: 'Telegram', gmail: 'Gmail' };
const IDENTITY: Record<string, string> = { email: 'Email', phone: 'Phone', telegram: 'Telegram account', widget_visitor: 'Website visitor', widget_user: 'Signed-in site user' };
const SHOW = [
  { id: 'active', label: 'Active' },
  { id: 'bot', label: 'Bot' },
  { id: 'open', label: 'Open' },
  { id: 'pending', label: 'Pending' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'all', label: 'All' },
];
const ASSIGNED = [
  { id: '', label: 'Anyone' },
  { id: 'me', label: 'Me' },
  { id: 'unassigned', label: 'Unassigned' },
];

interface Sla {
  due_at: string;
  breached: boolean;
}

const span = (ms: number) => {
  const min = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  return min < 60 ? `${min} min` : min < 48 * 60 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} days`;
};
/** "First response due in 12 min" / "Response overdue by 5 min". */
const slaText = (s: Sla | null) => {
  if (!s) return null;
  const left = new Date(s.due_at).getTime() - Date.now();
  return left < 0 || s.breached ? `Response overdue by ${span(left)}` : `First response due in ${span(left)}`;
};

/** Search params of the Inbox route (routes are registered dynamically, so they are untyped). */
const conversationSearch = (id: string) => ({ c: id }) as never;

export function InboxScreen() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { c?: unknown };
  const selected = typeof search.c === 'string' && /^[0-9a-f-]{36}$/i.test(search.c) ? search.c : null;
  const allowed = can(me.data, 'platform:inbox.read');
  const [show, setShow] = useState('active');
  const [assignee, setAssignee] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [cannedOpen, setCannedOpen] = useState(false);

  // Search as you type, debounced.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const params = new URLSearchParams({ status: show, ...(assignee ? { assignee } : {}), ...(query ? { q: query } : {}) });
  const list = useQuery({ queryKey: ['inbox', 'list', show, assignee, query], queryFn: () => api(`/api/inbox/conversations?${params.toString()}`), enabled: allowed, refetchInterval: 15_000 });
  const enabled = Boolean(list.data?.enabled);

  // Live updates: the stream ends with this screen.
  useEffect(() => {
    if (!allowed || !enabled) return;
    const es = new EventSource('/api/inbox/events');
    const refresh = () => void qc.invalidateQueries({ queryKey: ['inbox'] });
    es.addEventListener('changed', refresh);
    return () => {
      es.removeEventListener('changed', refresh);
      es.close();
    };
  }, [allowed, enabled, qc]);

  if (!allowed) return <EmptyState title="Inbox">Ask an Admin for access to customer conversations.</EmptyState>;
  if (list.error) return <Alert tone="error">{errorText(list.error)}</Alert>;
  if (!list.data) return <p className="text-muted">Loading…</p>;
  if (!enabled) {
    return (
      <>
        <PageHeader title="Inbox" />
        <EmptyState title="The Inbox needs the Omnichannel package">
          <p>Your plan does not include the Omnichannel package. Change the plan under Settings to talk to customers here.</p>
        </EmptyState>
      </>
    );
  }
  const conversations = (list.data.conversations ?? []) as any[];
  const counts = (list.data.counts ?? {}) as Record<string, number>;
  const waiting = (counts.open ?? 0) + (counts.pending ?? 0);

  return (
    <>
      <PageHeader
        title="Inbox"
        description={`Customer conversations from every channel. ${waiting} with your team, ${counts.bot ?? 0} with the bot, ${counts.resolved ?? 0} resolved.`}
        actions={
          can(me.data, 'platform:inbox.manage') && (
            <Button variant="secondary" onPress={() => setCannedOpen(true)}>
              Canned replies
            </Button>
          )
        }
      />
      <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <section aria-label="Conversations" className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 rounded-xl border border-line bg-white p-4">
            <Select label="Show" value={show} onChange={setShow} options={SHOW} />
            <Select label="Assigned to" value={assignee} onChange={setAssignee} options={ASSIGNED} />
            <TextField label="Search conversations" value={q} onChange={setQ} />
          </div>
          {conversations.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line bg-white p-4 text-sm text-muted">No conversations here.</p>
          ) : (
            <ul aria-label="Conversation list" className="flex flex-col gap-2">
              {conversations.map((c) => {
                const due = slaText(c.sla);
                return (
                  <li key={c.id}>
                    <Link
                      to="/inbox"
                      search={conversationSearch(c.id)}
                      aria-current={selected === c.id ? 'true' : undefined}
                      className={`flex min-h-11 flex-col gap-1 rounded-xl border bg-white p-3 text-sm hover:bg-ground ${selected === c.id ? 'border-accent' : 'border-line'}`}
                    >
                      <span className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-ink">{c.contact_name}</span>
                        {c.unread > 0 && <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-white">{c.unread} new</span>}
                      </span>
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="rounded bg-ground px-1.5 py-0.5 text-xs font-medium text-ink">{CHANNEL[c.channel] ?? c.channel}</span>
                        <Badge value={c.status} />
                      </span>
                      {c.subject && <span className="font-medium text-ink">{c.subject}</span>}
                      <span className="break-words text-muted">{c.preview || 'No messages yet'}</span>
                      <span className="text-xs text-muted">
                        {dateTime(c.last_message_at)} · {c.assignee_name ? `Assigned to ${c.assignee_name}` : 'Unassigned'}
                      </span>
                      {due && <span className={`text-xs font-medium ${c.sla?.breached ? 'text-bad' : 'text-warn'}`}>{due}</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <div className="min-w-0">
          {selected ? (
            <Conversation key={selected} id={selected} onGone={() => void navigate({ to: '/inbox' })} />
          ) : (
            <EmptyState title="Select a conversation">
              <p>Choose a conversation from the list to read it and reply.</p>
            </EmptyState>
          )}
        </div>
      </div>
      {cannedOpen && <CannedDialog onClose={() => setCannedOpen(false)} />}
    </>
  );
}

// ------------------------------------------------------------------ one conversation

function Conversation(props: { id: string; onGone: () => void }) {
  const { id } = props;
  const me = useMe();
  const qc = useQueryClient();
  const canReply = can(me.data, 'platform:inbox.reply');
  const canManage = can(me.data, 'platform:inbox.manage');
  const detail = useQuery({ queryKey: ['inbox', 'conversation', id], queryFn: () => api(`/api/inbox/conversations/${id}`), refetchInterval: 15_000, retry: false });
  const canned = useQuery({ queryKey: ['inbox-canned'], queryFn: () => api('/api/inbox/canned'), staleTime: 30_000 });
  const agents = useQuery({ queryKey: ['inbox-agents'], queryFn: () => api('/api/inbox/agents'), staleTime: 60_000 });
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const [order, setOrder] = useState('');
  const [status, setStatus] = useState<{ tone: 'info' | 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);

  const count = detail.data?.messages?.length ?? 0;
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [count]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['inbox'] });
  const act = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    try {
      const text = await fn();
      setStatus(text ? { tone: 'success', text } : null);
    } catch (e) {
      setStatus({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  if (detail.error) {
    return (
      <Card>
        <Alert tone="error">{errorText(detail.error)}</Alert>
        <Button variant="secondary" className="mt-3" onPress={props.onGone}>
          Back to the list
        </Button>
      </Card>
    );
  }
  if (!detail.data) return <p className="text-muted">Loading…</p>;

  const c = detail.data.conversation;
  const contact = detail.data.contact;
  const account = detail.data.account;
  const messages = detail.data.messages as any[];
  const links = [...(detail.data.links as any[]), ...(detail.data.related as any[])];
  const name = contact.name ?? 'Visitor';
  const due = slaText(c.sla);
  const post = (path: string, body: unknown) => api(`/api/inbox/conversations/${id}/${path}`, { body });
  const setTo = (to: 'open' | 'pending' | 'resolved', done: string) => act(async () => (await post('status', { status: to, version: c.version }), done));
  const assign = (assigneeId: string | null, done: string) => act(async () => (await post('assign', { assignee_id: assigneeId, version: c.version }), done));
  const myId = me.data?.user.id ?? '';
  const agentOptions = [{ id: '', label: 'Unassigned' }, ...((agents.data?.agents ?? []) as { id: string; name: string }[]).filter((a) => canManage || a.id === myId || a.id === c.assignee?.id).map((a) => ({ id: a.id, label: a.id === myId ? `${a.name} (me)` : a.name }))];
  const cannedReplies = (canned.data?.replies ?? []) as { id: string; title: string; body: string }[];

  const sendReply = (e: FormEvent) => {
    e.preventDefault();
    const body = reply.trim();
    if (!body) return;
    void act(async () => {
      await post('reply', { body });
      setReply('');
      return 'Reply sent.';
    });
  };
  const addNote = (e: FormEvent) => {
    e.preventDefault();
    const body = note.trim();
    if (!body) return;
    void act(async () => {
      await post('note', { body });
      setNote('');
      return 'Note added.';
    });
  };
  const linkOrder = (e: FormEvent) => {
    e.preventDefault();
    const number = order.trim().replace(/^#/, '');
    if (!number) return;
    void act(async () => {
      const r = await api<{ items: { id: string; number: number }[] }>(`/api/apps/ordering/entities/order?q=${encodeURIComponent(number)}&limit=10`);
      const hit = r.items.find((i) => String(i.number) === number);
      if (!hit) throw new ApiError(404, 'not_found', `No order with number ${number} was found.`);
      await post('link', { type: 'ordering::Order', id: hit.id });
      setOrder('');
      return `Order ${hit.number} linked.`;
    });
  };
  const download = (fileId: string) =>
    act(async () => {
      const r = await api<{ url: string }>(`/api/inbox/attachments/${fileId}`);
      window.location.assign(r.url);
      return null;
    });

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
      <section aria-label={`Conversation with ${name}`} className="flex min-w-0 flex-col gap-4">
        <Card as="div">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{name}</h2>
              <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
                <span>
                  {CHANNEL[c.channel] ?? c.channel} · {account.name}
                </span>
                <Badge value={c.status} />
                <span>{c.assignee ? `Assigned to ${c.assignee.name}` : 'Unassigned'}</span>
              </p>
              {c.subject && <p className="mt-1 text-sm font-medium">{c.subject}</p>}
              {due && <p className={`mt-1 text-sm font-medium ${c.sla?.breached ? 'text-bad' : 'text-warn'}`}>{due}</p>}
              {!due && c.first_response_at && <p className="mt-1 text-sm text-muted">First response {dateTime(c.first_response_at)}</p>}
            </div>
            {canReply && (
              <div role="group" aria-label="Conversation actions" className="flex flex-wrap gap-2">
                {c.assignee?.id !== myId && (
                  <Button variant="secondary" isDisabled={busy} onPress={() => assign(myId, 'Assigned to you.')}>
                    Assign to me
                  </Button>
                )}
                {c.status === 'open' && (
                  <Button variant="secondary" isDisabled={busy} onPress={() => setTo('pending', 'Marked pending: waiting for the customer.')}>
                    Mark pending
                  </Button>
                )}
                {c.status !== 'resolved' && (
                  <Button variant="secondary" isDisabled={busy} onPress={() => setTo('resolved', 'Conversation resolved.')}>
                    Resolve
                  </Button>
                )}
                {(c.status === 'resolved' || c.status === 'pending') && (
                  <Button variant="secondary" isDisabled={busy} onPress={() => setTo('open', 'Conversation reopened.')}>
                    Reopen
                  </Button>
                )}
              </div>
            )}
          </div>
          {canReply && <Select className="mt-3 max-w-xs" label="Assignee" value={c.assignee?.id ?? ''} isDisabled={busy} onChange={(v) => void assign(v || null, v ? 'Conversation assigned.' : 'Conversation unassigned.')} options={agentOptions} />}
        </Card>

        {c.status === 'bot' && (
          <Alert tone="info" title="The bot is handling this conversation">
            <p>It hands over by itself when it cannot help. You can step in at any time.</p>
            {canReply && (
              <Button className="mt-2" isDisabled={busy} onPress={() => setTo('open', 'You took over from the bot.')}>
                Take over
              </Button>
            )}
          </Alert>
        )}
        {account.status !== 'active' && (
          <Alert tone="warn" title={`The channel ${account.name} is ${String(account.status).replace(/_/g, ' ')}`}>
            Replies cannot be delivered until it is connected again under Channels.
          </Alert>
        )}
        <div aria-live="polite">{status && <Alert tone={status.tone}>{status.text}</Alert>}</div>

        <div ref={log} role="log" aria-live="polite" aria-label="Conversation messages" tabIndex={0} className="flex max-h-[32rem] min-h-32 flex-col gap-3 overflow-y-auto rounded-xl border border-line bg-white p-4">
          {messages.length === 0 && <p className="text-sm text-muted">No messages yet.</p>}
          {messages.map((m) => {
            const isNote = m.direction === 'note';
            const who = isNote ? `Internal note · ${m.author_name ?? 'Agent'}` : m.author_type === 'customer' ? name : m.author_type === 'agent' ? (m.author_name ?? 'Agent') : m.author_type === 'bot' ? 'Bot' : 'Automatic update';
            const tone = isNote ? 'border border-warn/40 bg-warn-soft' : m.direction === 'in' ? 'mr-8 bg-ground' : m.author_type === 'agent' ? 'ml-8 bg-accent-soft' : 'ml-8 border border-line bg-white';
            return (
              <div key={m.id} className={`rounded-lg p-3 text-sm ${tone}`}>
                <p className={`text-xs font-semibold ${isNote ? 'text-warn' : 'text-muted'}`}>
                  {who} · <time dateTime={m.created_at}>{dateTime(m.created_at)}</time>
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-ink">{m.body}</p>
                {(m.attachments as { file_id: string; name: string; size: number }[]).length > 0 && (
                  <ul aria-label="Attachments" className="mt-2 flex flex-wrap gap-2">
                    {(m.attachments as { file_id: string; name: string; size: number }[]).map((a) => (
                      <li key={a.file_id}>
                        <Button variant="secondary" aria-label={`Download ${a.name}`} onPress={() => download(a.file_id)}>
                          {a.name} ({Math.max(1, Math.round(a.size / 1024))} KB)
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {m.direction === 'out' && (m.delivery === 'pending' || m.delivery === 'sending') && <p className="mt-1 text-xs text-muted">Sending…</p>}
                {m.direction === 'out' && m.delivery === 'sent' && <p className="mt-1 text-xs text-muted">Sent</p>}
                {m.direction === 'out' && m.delivery === 'dead' && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <p className="text-xs font-medium text-bad">Not delivered: {m.delivery_error ?? 'the channel refused the message'}</p>
                    {canReply && (
                      <Button variant="secondary" isDisabled={busy} aria-label="Retry sending this message" onPress={() => act(async () => (await api(`/api/inbox/messages/${m.id}/retry`, { body: {} }), 'The message is queued again.'))}>
                        Retry
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {canReply && (
          <Card as="div">
            <form onSubmit={sendReply} className="flex flex-col gap-3">
              <TextArea label="Reply to customer" value={reply} onChange={setReply} rows={3} />
              <div className="flex flex-wrap items-end gap-3">
                {cannedReplies.length > 0 && (
                  <Select
                    className="min-w-56"
                    label="Canned reply"
                    value={null}
                    onChange={(v) => {
                      const hit = cannedReplies.find((r) => r.id === v);
                      if (hit) setReply(hit.body);
                    }}
                    options={cannedReplies.map((r) => ({ id: r.id, label: r.title }))}
                  />
                )}
                <Button type="submit" isDisabled={!reply.trim() || busy}>
                  Send reply
                </Button>
              </div>
            </form>
            <form onSubmit={addNote} className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
              <TextArea label="Internal note" value={note} onChange={setNote} rows={2} description="Only your team sees notes; the customer never does." />
              <div>
                <Button type="submit" variant="secondary" isDisabled={!note.trim() || busy}>
                  Add note
                </Button>
              </div>
            </form>
          </Card>
        )}
      </section>

      <section aria-label="Conversation details" className="flex flex-col gap-4">
        <Card title="Contact">
          <dl className="flex flex-col gap-2 text-sm">
            <div>
              <dt className="text-muted">Name</dt>
              <dd className="break-words">{name}</dd>
            </div>
            <div>
              <dt className="text-muted">Email</dt>
              <dd className="break-all">{contact.email ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted">Phone</dt>
              <dd>{contact.phone ?? '—'}</dd>
            </div>
          </dl>
          <h3 className="mt-3 text-sm font-semibold">Known as</h3>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {(contact.identities as { kind: string; verified: boolean }[]).map((i, n) => (
              <li key={`${i.kind}-${n}`} className="flex flex-wrap items-center gap-2">
                {IDENTITY[i.kind] ?? i.kind}
                {i.verified ? <span className="rounded-full bg-ok-soft px-2 py-0.5 text-xs font-medium text-ok">verified</span> : <span className="text-xs text-muted">not verified</span>}
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Linked records">
          {links.length === 0 && !detail.data.hidden_links && <p className="text-sm text-muted">Nothing linked yet.</p>}
          <ul className={links.length ? 'flex flex-col text-sm' : 'hidden'}>
            {links.map((l) => (
              <li key={`${l.type}-${l.id}-${l.rel}`}>
                {l.path ? (
                  <Link to={l.path} className="inline-flex min-h-11 items-center text-accent underline">
                    {l.label} {l.title ?? ''}
                  </Link>
                ) : (
                  <span className="inline-flex min-h-11 items-center">
                    {l.label} {l.title ?? ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {detail.data.hidden_links > 0 && <p className="text-sm text-muted">{detail.data.hidden_links} linked record(s) you cannot see.</p>}
          {canReply && (
            <form onSubmit={linkOrder} className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
              <h3 className="text-sm font-semibold">Link an order</h3>
              <TextField label="Order number" inputMode="numeric" value={order} onChange={setOrder} />
              <div>
                <Button type="submit" variant="secondary" isDisabled={!order.trim() || busy}>
                  Link order
                </Button>
              </div>
            </form>
          )}
        </Card>

        {((detail.data.possible_matches ?? []) as any[]).length > 0 && (
          <Card title="Possibly the same person">
            <p className="text-sm text-muted">These conversations use the same email address. It was not verified, so they are not merged: check before you share anything.</p>
            <ul className="flex flex-col text-sm">
              {(detail.data.possible_matches as { id: string; channel: string; status: string; last_message_at: string }[]).map((o) => (
                <li key={o.id}>
                  <Link to="/inbox" search={conversationSearch(o.id)} className="inline-flex min-h-11 flex-wrap items-center gap-2 text-accent underline">
                    {CHANNEL[o.channel] ?? o.channel} · {dateTime(o.last_message_at)} <Badge value={o.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {(detail.data.other_conversations as any[]).length > 0 && (
          <Card title="Other conversations">
            <ul className="flex flex-col text-sm">
              {(detail.data.other_conversations as { id: string; channel: string; status: string; last_message_at: string }[]).map((o) => (
                <li key={o.id}>
                  <Link to="/inbox" search={conversationSearch(o.id)} className="inline-flex min-h-11 flex-wrap items-center gap-2 text-accent underline">
                    {CHANNEL[o.channel] ?? o.channel} · {dateTime(o.last_message_at)} <Badge value={o.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card title="Assistant">
          <p className="text-sm text-muted">Ask the assistant to look things up or to act for this customer, for example to cancel an order.</p>
          <Link to="/assistant" className="inline-flex min-h-11 items-center text-accent underline">
            Ask the assistant
          </Link>
        </Card>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ canned replies

function CannedDialog(props: { onClose: () => void }) {
  const qc = useQueryClient();
  const canned = useQuery({ queryKey: ['inbox-canned'], queryFn: () => api('/api/inbox/canned') });
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['inbox-canned'] });
    } catch (e) {
      setError(errorText(e));
    }
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('/api/inbox/canned', { body: { title: title.trim(), body: body.trim() } });
      setTitle('');
      setBody('');
    });
  };
  const replies = (canned.data?.replies ?? []) as { id: string; title: string; body: string }[];
  return (
    <ModalDialog title="Canned replies" isOpen onOpenChange={(o) => !o && props.onClose()}>
      <div className="flex flex-col gap-4">
        {replies.length === 0 ? (
          <p className="text-sm text-muted">No canned replies yet.</p>
        ) : (
          <ul aria-label="Canned replies" className="flex max-h-60 flex-col divide-y divide-line overflow-y-auto text-sm">
            {replies.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block font-medium">{r.title}</span>
                  <span className="block break-words text-muted">{r.body}</span>
                </span>
                <Button variant="danger" aria-label={`Delete canned reply ${r.title}`} onPress={() => run(() => api(`/api/inbox/canned/${r.id}`, { method: 'DELETE' }))}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={add} className="flex flex-col gap-3 border-t border-line pt-4">
          <TextField label="Title" value={title} onChange={setTitle} />
          <TextArea label="Text" value={body} onChange={setBody} rows={3} />
          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onPress={props.onClose}>
              Close
            </Button>
            <Button type="submit" isDisabled={!title.trim() || !body.trim()}>
              Add canned reply
            </Button>
          </div>
        </form>
      </div>
    </ModalDialog>
  );
}
