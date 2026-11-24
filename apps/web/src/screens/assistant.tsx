import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { can, useMe } from '../components/shell';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, ModalDialog, PageHeader, TextArea, TextField } from '../components/ui';
import { api, ApiError, dateTime } from '../lib/api';

/**
 * Assistant: a chat with the workspace assistant (streamed over Server-Sent Events, with
 * confirmations for low-risk actions and approvals for high-risk ones) and the knowledge
 * it may quote (help articles and documents).
 */

type Tab = 'chat' | 'knowledge';

interface ToolCall {
  id: string;
  tool: string;
  label: string;
  risk: 'read' | 'low' | 'high';
  status: string;
  error: string | null;
  approval_request_id: string | null;
}
interface Citation {
  n: number;
  title: string;
  kind: string;
  excerpt: string;
}
interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tool_calls: string[];
  citations: Citation[];
  created_at: string;
}
interface ConversationData {
  conversation: { id: string; title: string; status: 'idle' | 'running' | 'waiting_confirm' | 'waiting_approval' };
  messages: Message[];
  tool_calls: ToolCall[];
}

const searchParam = (name: string) => (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get(name) : null);

export function AssistantScreen() {
  const me = useMe();
  const [tab, setTab] = useState<Tab>('chat');
  const allowed = can(me.data, 'platform:assistant.use');
  const overview = useQuery({ queryKey: ['assistant-overview'], queryFn: () => api('/api/assistant/overview'), enabled: allowed });
  if (!allowed) return <EmptyState title="Assistant">Ask an Admin for access to the assistant.</EmptyState>;
  if (overview.error) return <Alert tone="error">{(overview.error as ApiError).message}</Alert>;
  if (!overview.data) return <p className="text-muted">Loading…</p>;
  if (!overview.data.enabled) {
    return (
      <>
        <PageHeader title="Assistant" />
        <EmptyState title="The assistant needs the Bot package">
          <p>Your plan does not include the Bot package. An Owner can change the plan under Settings.</p>
          <Link to="/settings" className="mt-2 inline-flex min-h-11 items-center font-medium text-accent underline">
            Open Settings
          </Link>
        </EmptyState>
      </>
    );
  }
  const u = overview.data.usage as { used: number; limit: number } | null;
  return (
    <>
      <PageHeader
        title="Assistant"
        description="Ask about orders, records and your documents. The assistant acts with your permissions; actions that change something ask you first, and high-risk ones need an approval."
      />
      <p className="mb-4 text-sm text-muted" data-testid="assistant-usage">
        Model: <span className="text-ink">{overview.data.model}</span>
        {u && (
          <>
            {' · '}Tokens this month:{' '}
            <span className="text-ink">
              {u.used.toLocaleString('en')} of {u.limit.toLocaleString('en')}
            </span>
          </>
        )}
      </p>
      <div role="group" aria-label="Sections" className="mb-4 flex flex-wrap gap-2">
        {(
          [
            ['chat', 'Chat'],
            ['knowledge', 'Knowledge'],
          ] as const
        ).map(([k, l]) => (
          <Button key={k} variant={tab === k ? 'primary' : 'secondary'} aria-pressed={tab === k} onPress={() => setTab(k)}>
            {l}
          </Button>
        ))}
      </div>
      {tab === 'chat' && <ChatPanel />}
      {tab === 'knowledge' && <KnowledgePanel />}
    </>
  );
}

// ---------------------------------------------------------------- chat

/** Reads a `text/event-stream` response body and calls `on` for every event. */
async function readEvents(res: Response, on: (event: string, data: any) => void) {
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    throw new ApiError(res.status, body?.error ?? 'error', body?.message ?? (res.statusText || 'The assistant is not available.'));
  }
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (block: string) => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (!data.length) return;
    try {
      on(event, JSON.parse(data.join('\n')));
    } catch {
      /* not JSON: ignore the event */
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i = buffer.indexOf('\n\n');
    while (i >= 0) {
      flush(buffer.slice(0, i));
      buffer = buffer.slice(i + 2);
      i = buffer.indexOf('\n\n');
    }
  }
  if (buffer.trim()) flush(buffer);
}

interface Live {
  /** the user's text of the turn in progress (not yet in the stored conversation) */
  sent: string | null;
  text: string;
  tools: { id: string; label: string; status: string }[];
}

const STATUS_TEXT: Record<string, string> = {
  pending_confirm: 'Needs your confirmation',
  pending_approval: 'Waiting for approval',
  executed: 'Done',
  declined: 'Declined',
  rejected: 'Rejected',
  expired: 'Expired',
  failed: 'Failed',
};
const STATUS_TONE: Record<string, string> = {
  pending_confirm: 'bg-warn-soft text-warn',
  pending_approval: 'bg-warn-soft text-warn',
  executed: 'bg-ok-soft text-ok',
  declined: 'bg-ground text-muted',
  rejected: 'bg-bad-soft text-bad',
  expired: 'bg-bad-soft text-bad',
  failed: 'bg-bad-soft text-bad',
};
const RISK_TEXT: Record<string, string> = { read: 'Read only', low: 'Low risk', high: 'High risk' };

function Pill({ className, children }: { className: string; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
}

function ChatPanel() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string | null>(() => searchParam('c'));
  const [text, setText] = useState('');
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const explained = useRef(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  const busy = live !== null;

  const list = useQuery({ queryKey: ['assistant-conversations'], queryFn: () => api('/api/assistant/conversations') });
  const conv = useQuery<ConversationData, ApiError>({
    queryKey: ['assistant-conversation', selected],
    queryFn: () => api(`/api/assistant/conversations/${selected}`),
    enabled: Boolean(selected),
    // An approver (or a turn in another tab) may finish it: keep looking while it is open.
    refetchInterval: (q) => (!busy && ['waiting_approval', 'running'].includes(q.state.data?.conversation.status ?? '') ? 2000 : false),
  });

  // The stream must not outlive the screen.
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conv.data?.messages.length, live?.text, live?.tools.length]);

  const select = (id: string | null) => {
    setSelected(id);
    setError(null);
    void navigate({ to: id ? `/assistant?c=${id}` : '/assistant', replace: true });
  };

  /** Runs one streamed turn (a new message, or a confirm / decline) and then reloads the conversation. */
  const stream = async (url: string, body: unknown, id: string, sent: string | null) => {
    setError(null);
    setLive({ sent, text: '', tools: [] });
    const ac = new AbortController();
    abort.current = ac;
    try {
      const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
      await readEvents(res, (event, data) => {
        if (event === 'delta') setLive((l) => (l ? { ...l, text: l.text + String(data.text ?? '') } : l));
        else if (event === 'tool') setLive((l) => (l ? { ...l, tools: [...l.tools.filter((t) => t.id !== data.id), { id: String(data.id), label: String(data.label ?? data.tool), status: String(data.status) }] } : l));
        else if (event === 'error') setError(String(data.message ?? 'The assistant could not finish this turn.'));
      });
    } catch (e) {
      if (!ac.signal.aborted) setError((e as Error).message);
    } finally {
      if (!ac.signal.aborted) {
        // Swap the live bubbles for the stored conversation in one step (no duplicate, no gap).
        try {
          qc.setQueryData(['assistant-conversation', id], await api<ConversationData>(`/api/assistant/conversations/${id}`));
        } catch {
          await qc.invalidateQueries({ queryKey: ['assistant-conversation', id] });
        }
        setLive(null);
        void qc.invalidateQueries({ queryKey: ['assistant-conversations'] });
        void qc.invalidateQueries({ queryKey: ['assistant-overview'] });
      }
    }
  };

  const create = async (input: { title?: string; context?: Record<string, unknown> } = {}): Promise<string | null> => {
    setError(null);
    try {
      const r = await api<{ id: string }>('/api/assistant/conversations', { body: input });
      await qc.invalidateQueries({ queryKey: ['assistant-conversations'] });
      select(r.id);
      return r.id;
    } catch (e) {
      setError((e as ApiError).message);
      return null;
    }
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const message = text.trim();
    if (!message || busy) return;
    const id = selected ?? (await create());
    if (!id) return;
    setText('');
    await stream(`/api/assistant/conversations/${id}/messages`, { text: message }, id, message);
  };

  const decide = (call: ToolCall, decision: 'confirm' | 'decline') => {
    if (!selected || busy) return;
    void stream(`/api/assistant/tool-calls/${call.id}/decision`, { decision }, selected, null);
  };

  // "Explain with the assistant" from a record: one new conversation, one question.
  useEffect(() => {
    const explain = searchParam('explain');
    if (!explain || explained.current) return;
    explained.current = true;
    const cut = explain.lastIndexOf(':');
    const type = explain.slice(0, cut);
    const recordId = explain.slice(cut + 1);
    if (cut < 1 || !/^[a-z_]+::[A-Za-z]+$/.test(type) || !/^[0-9a-f-]{36}$/i.test(recordId)) {
      void navigate({ to: '/assistant', replace: true });
      return;
    }
    const question = `Explain this record: ${type} ${recordId}`;
    void (async () => {
      const id = await create({ title: 'Explain a record', context: { record: { type, id: recordId } } });
      if (id) await stream(`/api/assistant/conversations/${id}/messages`, { text: question }, id, question);
    })();
    // Runs once on arrival (guarded by the ref): `create` and `stream` only use stable setters.
  }, []);

  const data = conv.data;
  const calls = new Map((data?.tool_calls ?? []).map((c) => [c.id, c]));
  const status = data?.conversation.status;
  const blocked = status === 'waiting_confirm' || status === 'waiting_approval';
  const conversations = (list.data?.conversations ?? []) as { id: string; title: string; status: string; updated_at: string }[];

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <Card title="Conversations">
        <Button className="mb-3 w-full" variant="secondary" onPress={() => void create()} isDisabled={busy}>
          New conversation
        </Button>
        {conversations.length === 0 && <p className="text-sm text-muted">No conversations yet.</p>}
        <ul className="flex flex-col gap-1">
          {conversations.map((c) => (
            <li key={c.id}>
              <Button variant={c.id === selected ? 'ghost' : 'secondary'} className={`w-full !justify-start text-left ${c.id === selected ? 'bg-accent-soft' : ''}`} aria-current={c.id === selected ? 'true' : undefined} onPress={() => select(c.id)} isDisabled={busy && c.id !== selected}>
                <span className="truncate">{c.title}</span>
              </Button>
            </li>
          ))}
        </ul>
      </Card>

      <Card title={data?.conversation.title ?? 'Chat'}>
        {conv.error && <Alert tone="error">{conv.error.message}</Alert>}
        <div ref={logRef} role="log" aria-live="polite" aria-label="Conversation with the assistant" tabIndex={0} className="mb-4 flex max-h-[60vh] min-h-40 flex-col gap-3 overflow-y-auto rounded-lg border border-line bg-white p-3">
          {!selected && !live && <p className="text-sm text-muted">Start a conversation: ask about an order, a record, the Integration Hub, or a question your documents answer.</p>}
          {selected && data && data.messages.length === 0 && !live && <p className="text-sm text-muted">No messages yet.</p>}
          {(data?.messages ?? []).map((m) => (
            <MessageView key={m.id} message={m} calls={m.tool_calls.map((id) => calls.get(id)).filter((c): c is ToolCall => Boolean(c))} onDecide={decide} busy={busy} />
          ))}
          {live?.sent && <Bubble role="user" text={live.sent} />}
          {live && (
            <div data-testid="assistant-streaming">
              {live.text && <Bubble role="assistant" text={live.text} />}
              {live.tools.map((t) => (
                <p key={t.id} className="mt-1 text-sm text-muted">
                  {t.label}: {STATUS_TEXT[t.status] ?? t.status}
                </p>
              ))}
              {!live.text && live.tools.length === 0 && <p className="text-sm text-muted">The assistant is working…</p>}
            </div>
          )}
        </div>
        {status === 'waiting_approval' && !busy && (
          <div className="mb-3">
            <Alert tone="info" title="Waiting for approval">
              An action in this conversation needs another approver. The assistant continues here as soon as it is decided.
            </Alert>
          </div>
        )}
        {status === 'waiting_confirm' && !busy && (
          <div className="mb-3">
            <Alert tone="info">Confirm or decline the pending action above to continue.</Alert>
          </div>
        )}
        {error && (
          <div className="mb-3">
            <Alert tone="error">{error}</Alert>
          </div>
        )}
        <form onSubmit={send} className="flex flex-col gap-2">
          <TextArea label="Message to the assistant" value={text} onChange={setText} rows={3} />
          <div>
            <Button type="submit" isDisabled={busy || blocked || !text.trim()}>
              Send
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function Bubble({ role, text }: { role: 'user' | 'assistant'; text: string }) {
  return (
    <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap ${role === 'user' ? 'self-end bg-accent text-white' : 'self-start bg-ground text-ink'}`}>
      <span className="block text-xs font-semibold">{role === 'user' ? 'You' : 'Assistant'}</span>
      {text}
    </div>
  );
}

function MessageView({ message, calls, onDecide, busy }: { message: Message; calls: ToolCall[]; onDecide: (c: ToolCall, d: 'confirm' | 'decline') => void; busy: boolean }) {
  return (
    <>
      {message.text && <Bubble role={message.role} text={message.text} />}
      {message.citations.length > 0 && (
        <div className="max-w-[85%] self-start text-sm" data-testid="assistant-citations">
          <p className="font-medium text-ink">Sources</p>
          <ul className="mt-1 flex flex-col gap-1">
            {message.citations.map((c) => (
              <li key={c.n} className="text-muted">
                <span className="font-medium text-ink">
                  [{c.n}] {c.title}
                </span>
                {c.excerpt ? ` — ${c.excerpt}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {calls.map((c) => (
        <div key={c.id} className="max-w-[85%] self-start rounded-lg border border-line bg-white p-3 text-sm" data-testid="assistant-tool-call">
          <p className="font-medium text-ink">{c.label}</p>
          <p className="mt-1 flex flex-wrap items-center gap-2">
            <Pill className={c.risk === 'high' ? 'bg-bad-soft text-bad' : c.risk === 'low' ? 'bg-warn-soft text-warn' : 'bg-ground text-muted'}>{RISK_TEXT[c.risk] ?? c.risk}</Pill>
            <Pill className={STATUS_TONE[c.status] ?? 'bg-ground text-muted'}>{STATUS_TEXT[c.status] ?? c.status}</Pill>
          </p>
          {c.error && <p className="mt-1 text-bad">{c.error}</p>}
          {c.status === 'pending_confirm' && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button onPress={() => onDecide(c, 'confirm')} isDisabled={busy}>
                Confirm<span className="sr-only">: {c.label}</span>
              </Button>
              <Button variant="secondary" onPress={() => onDecide(c, 'decline')} isDisabled={busy}>
                Decline<span className="sr-only">: {c.label}</span>
              </Button>
            </div>
          )}
          {c.status === 'pending_approval' && (
            <Link to="/approvals" className="mt-1 inline-flex min-h-11 items-center font-medium text-accent underline">
              Open Approvals
            </Link>
          )}
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- knowledge

interface Source {
  id: string;
  kind: 'help' | 'document';
  title: string;
  public: boolean;
  status: string;
  chunk_count: number;
  unembedded: number;
  error: string | null;
  updated_at: string;
}

const KIND_TEXT: Record<string, string> = { help: 'Help article', document: 'Document' };
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

function KnowledgePanel() {
  const me = useMe();
  const qc = useQueryClient();
  const manage = can(me.data, 'platform:knowledge.manage');
  const [dialog, setDialog] = useState<'help' | 'document' | null>(null);
  const [removing, setRemoving] = useState<Source | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const q = useQuery({
    queryKey: ['knowledge-sources'],
    queryFn: () => api('/api/knowledge/sources'),
    refetchInterval: (query) => (((query.state.data?.sources ?? []) as Source[]).some((s) => s.status === 'pending' || s.unembedded > 0) ? 2000 : false),
  });
  const sources = (q.data?.sources ?? []) as Source[];
  const refresh = () => qc.invalidateQueries({ queryKey: ['knowledge-sources'] });
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'success', text: done });
      await refresh();
    } catch (e) {
      setMsg({ tone: 'error', text: (e as ApiError).message });
    }
  };
  return (
    <Card title="Knowledge">
      <p className="mb-3 text-sm text-muted">Help articles and documents the assistant searches and cites. Only sources marked for customers are ever quoted by bots.</p>
      {manage && (
        <div className="mb-3 flex flex-wrap gap-2">
          <Button onPress={() => setDialog('help')}>Add help article</Button>
          <Button variant="secondary" onPress={() => setDialog('document')}>
            Upload document
          </Button>
        </div>
      )}
      {msg && (
        <div className="mb-3">
          <Alert tone={msg.tone}>{msg.text}</Alert>
        </div>
      )}
      {q.error && <Alert tone="error">{(q.error as ApiError).message}</Alert>}
      {sources.length === 0 && !q.isPending ? (
        <p className="text-sm text-muted">Nothing here yet. Add a help article or upload a text document.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Knowledge sources</caption>
            <thead className="text-muted">
              <tr>
                <th scope="col" className="py-2 font-medium">Title</th>
                <th scope="col" className="py-2 font-medium">Kind</th>
                <th scope="col" className="py-2 font-medium">Customers can see it</th>
                <th scope="col" className="py-2 font-medium">Status</th>
                <th scope="col" className="py-2 font-medium">Passages</th>
                <th scope="col" className="py-2 font-medium">Updated</th>
                {manage && <th scope="col" className="py-2 font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id} className="border-t border-line align-top">
                  <th scope="row" className="py-2 pr-3 font-medium">
                    {s.title}
                    {s.error && <span className="block font-normal text-bad">{s.error}</span>}
                  </th>
                  <td className="py-2 pr-3">{KIND_TEXT[s.kind] ?? s.kind}</td>
                  <td className="py-2 pr-3">{s.public ? 'Yes' : 'No'}</td>
                  <td className="py-2 pr-3">
                    <Badge value={s.status} />
                  </td>
                  <td className="py-2 pr-3">
                    {s.chunk_count}
                    {s.unembedded > 0 && <span className="block text-muted">{s.unembedded} waiting for embeddings</span>}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">{dateTime(s.updated_at)}</td>
                  {manage && (
                    <td className="py-2">
                      <div className="flex flex-wrap gap-2">
                        <Button variant="secondary" onPress={() => run(() => api(`/api/knowledge/sources/${s.id}`, { method: 'PATCH', body: { public: !s.public } }), s.public ? `${s.title} is now hidden from customers.` : `Bots may now quote ${s.title} to customers.`)}>
                          {s.public ? 'Hide from customers' : 'Show to customers'}
                          <span className="sr-only">: {s.title}</span>
                        </Button>
                        <Button variant="secondary" onPress={() => run(() => api(`/api/knowledge/sources/${s.id}/reindex`, { body: {} }), `Re-indexing ${s.title}.`)}>
                          Re-index<span className="sr-only">: {s.title}</span>
                        </Button>
                        <Button variant="danger" onPress={() => setRemoving(s)}>
                          Delete<span className="sr-only">: {s.title}</span>
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dialog === 'help' && <HelpDialog onClose={() => setDialog(null)} onSaved={(t) => void run(async () => undefined, `${t} was added and is being indexed.`)} />}
      {dialog === 'document' && <DocumentDialog onClose={() => setDialog(null)} onSaved={(t) => void run(async () => undefined, `${t} was uploaded and is being indexed.`)} />}
      {removing && (
        <ModalDialog title="Delete this source?" isOpen onOpenChange={(o) => !o && setRemoving(null)}>
          <p className="mb-4 text-sm">
            <strong>{removing.title}</strong> will no longer be searched or cited. This cannot be undone.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger"
              onPress={async () => {
                const s = removing;
                setRemoving(null);
                await run(() => api(`/api/knowledge/sources/${s.id}`, { method: 'DELETE' }), `${s.title} was deleted.`);
              }}
            >
              Delete source
            </Button>
            <Button variant="secondary" onPress={() => setRemoving(null)}>
              Cancel
            </Button>
          </div>
        </ModalDialog>
      )}
    </Card>
  );
}

function HelpDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (title: string) => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pub, setPub] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api('/api/knowledge/sources', { body: { title: title.trim(), body: body.trim(), public: pub } });
      onSaved(title.trim());
      onClose();
    } catch (err) {
      setError((err as ApiError).message);
      setSaving(false);
    }
  };
  return (
    <ModalDialog title="Add help article" isOpen onOpenChange={(o) => !o && onClose()}>
      <form onSubmit={submit} className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto">
        <TextField label="Title" value={title} onChange={setTitle} isRequired />
        <TextArea label="Text" value={body} onChange={setBody} rows={8} />
        <Checkbox isSelected={pub} onChange={setPub}>
          Bots may quote this to customers
        </Checkbox>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" isDisabled={saving || !title.trim() || !body.trim()}>
            Save article
          </Button>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

function DocumentDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (title: string) => void }) {
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [pub, setPub] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pick = (f: File | undefined) => {
    setError(null);
    setFile(null);
    if (!f) return;
    if (!/\.(txt|md|markdown|csv)$/i.test(f.name)) return setError('Choose a .txt, .md or .csv file.');
    if (f.size > MAX_DOCUMENT_BYTES) return setError('Documents can be at most 2 MB.');
    const reader = new FileReader();
    reader.onload = () => {
      setFile({ name: f.name, content: String(reader.result ?? '') });
      setTitle((t) => t || f.name.replace(/\.[^.]+$/, ''));
    };
    reader.onerror = () => setError('The file could not be read.');
    reader.readAsText(f);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setError(null);
    setSaving(true);
    try {
      await api('/api/knowledge/documents', { body: { title: title.trim(), filename: file.name, content: file.content, public: pub } });
      onSaved(title.trim());
      onClose();
    } catch (err) {
      setError((err as ApiError).message);
      setSaving(false);
    }
  };
  return (
    <ModalDialog title="Upload document" isOpen onOpenChange={(o) => !o && onClose()}>
      <form onSubmit={submit} className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto">
        <div className="flex flex-col gap-1">
          <label htmlFor="knowledge-file" className="text-sm font-medium text-ink">
            Text file (.txt, .md or .csv)
          </label>
          <input id="knowledge-file" type="file" accept=".txt,.md,.markdown,.csv,text/plain,text/markdown,text/csv" onChange={(e) => pick(e.target.files?.[0])} className="min-h-11 rounded-lg border border-line bg-white px-3 py-2 text-base text-ink file:mr-3 file:min-h-8 file:rounded-md file:border-0 file:bg-ground file:px-3 file:text-sm file:font-medium file:text-ink" />
          <span className="text-sm text-muted">At most 2 MB of text.</span>
        </div>
        <TextField label="Title" value={title} onChange={setTitle} isRequired />
        <Checkbox isSelected={pub} onChange={setPub}>
          Bots may quote this to customers
        </Checkbox>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" isDisabled={saving || !file || !title.trim()}>
            Upload
          </Button>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
