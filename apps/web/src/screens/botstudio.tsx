import { BOT_CHANNELS, BOT_NODE_TYPES, BotGraph, botOutputPorts, validateBotGraph, type BotChannel, type BotNode } from '@aod/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { BotNodeConfigForm, CHANNEL_LABELS, defaultBotConfig, type BotMeta } from '../components/bot-forms';
import { can, useMe } from '../components/shell';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, ModalDialog, PageHeader, Select, TextField } from '../components/ui';
import { autoLayout, connect, describeNode, freeSpot, NODE_LABELS, orderedNodes, problemsByNode, WorkflowCanvas, type NodeOverlay } from '../components/workflow-canvas';
import { api, ApiError, dateTime } from '../lib/api';

/**
 * Bot Studio: conversational flows on the workflow canvas. The outline view offers the
 * same editing by keyboard and screen reader (add, connect, configure, delete).
 */

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));
const useBotMeta = () => useQuery<BotMeta>({ queryKey: ['bot-meta'], queryFn: () => api('/api/bots/meta'), staleTime: 30_000 });
const channelNames = (channels: string[] | null | undefined) => (channels ?? []).map((c) => CHANNEL_LABELS[c as BotChannel] ?? c).join(', ');
/** Mirrors the server's node limit for the live (advisory) validation. */
const MAX_BOT_NODES = 60;
const ADDABLE = BOT_NODE_TYPES.filter((t) => t !== 'start');

type Message = { tone: 'info' | 'error' | 'success'; text: string; details?: string[] };

// ------------------------------------------------------------------ list

export function BotStudioScreen() {
  const me = useMe();
  const allowed = can(me.data, 'platform:bots.read');
  const list = useQuery({ queryKey: ['bots'], queryFn: () => api('/api/bots'), enabled: allowed, refetchInterval: 10_000 });
  const [open, setOpen] = useState(false);
  if (!allowed) return <EmptyState title="Bot Studio">Ask a Manager or Admin for access to bot flows.</EmptyState>;
  if (list.error) return <Alert tone="error">{errorText(list.error)}</Alert>;
  if (!list.data) return <p className="text-muted">Loading…</p>;
  const flows = (list.data.flows ?? []) as any[];
  return (
    <>
      <PageHeader
        title="Bot Studio"
        description="Flows that answer customers on your channels: look things up, ask questions, let the assistant answer from your help articles, and hand over to the Inbox."
        actions={list.data.enabled && can(me.data, 'platform:bots.manage') && <Button onPress={() => setOpen(true)}>New bot flow</Button>}
      />
      {!list.data.enabled ? (
        <EmptyState title="Bot Studio needs the Bot package">
          <p>Your plan does not include the Bot package. Change the plan under Settings to build bot flows.</p>
        </EmptyState>
      ) : (
        <Card title="Bot flows">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Bot flows</caption>
              <thead className="text-muted">
                <tr>
                  <th scope="col" className="py-2 font-medium">Name</th>
                  <th scope="col" className="py-2 font-medium">Status</th>
                  <th scope="col" className="py-2 font-medium">Channels</th>
                  <th scope="col" className="py-2 font-medium">Published</th>
                  <th scope="col" className="py-2 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {flows.map((f) => (
                  <tr key={f.id} className="border-t border-line">
                    <td className="py-2">
                      <Link to={`/bot-studio/${f.id}`} className="inline-flex min-h-11 items-center font-medium text-accent underline">
                        {f.name}
                      </Link>
                    </td>
                    <td className="py-2">
                      <Badge value={f.status} />
                    </td>
                    <td className="py-2">{channelNames(f.channels) || '—'}</td>
                    <td className="py-2">{f.published_number ? `v${f.published_number}` : '—'}</td>
                    <td className="py-2">{dateTime(f.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {flows.length === 0 && <p className="text-muted">No bot flows yet. Start from the order status template or an empty flow.</p>}
        </Card>
      )}
      {open && <NewFlowDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function NewFlowDialog(props: { onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [start, setStart] = useState<'order_status' | 'empty'>('order_status');
  const [channels, setChannels] = useState<BotChannel[]>(['widget']);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ id: string }>('/api/bots', { body: { name, channels, ...(start === 'order_status' ? { template: 'order_status' } : {}) } });
      props.onClose();
      void navigate({ to: `/bot-studio/${r.id}` });
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <ModalDialog title="New bot flow" isOpen onOpenChange={(o) => !o && props.onClose()}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <TextField label="Name" value={name} onChange={setName} isRequired />
        <Select
          label="Start from"
          value={start}
          onChange={setStart}
          options={[
            { id: 'order_status', label: 'Order status and handoff' },
            { id: 'empty', label: 'Empty flow' },
          ]}
        />
        <fieldset>
          <legend className="text-sm font-medium text-ink">Channels</legend>
          <div className="flex flex-col">
            {BOT_CHANNELS.map((ch) => (
              <Checkbox key={ch} isSelected={channels.includes(ch)} onChange={(on) => setChannels(on ? [...channels, ch] : channels.filter((x) => x !== ch))}>
                {CHANNEL_LABELS[ch]}
              </Checkbox>
            ))}
          </div>
        </fieldset>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onPress={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" isDisabled={!name.trim() || channels.length === 0}>
            Create
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

// ------------------------------------------------------------------ editor

type View = 'canvas' | 'outline';

function useHistory() {
  const [graph, setGraph] = useState<BotGraph | null>(null);
  const undo = useRef<BotGraph[]>([]);
  const redo = useRef<BotGraph[]>([]);
  const [, bump] = useState(0);
  const change = useCallback((next: BotGraph, opts?: { silent?: boolean }) => {
    setGraph((prev) => {
      if (prev && !opts?.silent) {
        undo.current = [...undo.current.slice(-99), prev];
        redo.current = [];
      }
      return next;
    });
    bump((n) => n + 1);
  }, []);
  const doUndo = () => {
    const prev = undo.current.pop();
    if (prev && graph) {
      redo.current.push(graph);
      setGraph(prev);
      bump((n) => n + 1);
    }
  };
  const doRedo = () => {
    const next = redo.current.pop();
    if (next && graph) {
      undo.current.push(graph);
      setGraph(next);
      bump((n) => n + 1);
    }
  };
  const reset = useCallback((g: BotGraph) => {
    undo.current = [];
    redo.current = [];
    setGraph(g);
  }, []);
  return { graph, change, undo: doUndo, redo: doRedo, canUndo: undo.current.length > 0, canRedo: redo.current.length > 0, reset };
}

const uniqueId = (g: BotGraph, base: string) => {
  let i = 1;
  while (g.nodes.some((n) => n.id === `${base}_${i}`)) i++;
  return `${base}_${i}`;
};

const EMPTY: BotGraph = { nodes: [{ id: 'start', type: 'start', name: 'Customer writes', position: { x: 0, y: 0 }, config: { channels: ['widget'] } }], edges: [] };
const graphOf = (data: any): BotGraph => (data.draft?.graph ?? data.published?.graph ?? EMPTY) as BotGraph;

export function BotFlowEditorScreen() {
  const { id } = useParams({ strict: false }) as { id: string };
  const me = useMe();
  const qc = useQueryClient();
  const allowed = can(me.data, 'platform:bots.read');
  const canManage = can(me.data, 'platform:bots.manage');
  const meta = useBotMeta();
  const flow = useQuery({ queryKey: ['bot', id], queryFn: () => api(`/api/bots/${id}`), enabled: allowed });
  const h = useHistory();
  const [view, setView] = useState<View>('canvas');
  const [selected, setSelected] = useState<string | null>(null);
  const [serverProblems, setServerProblems] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  /** optimistic-concurrency version of the open draft (undefined: no draft open) */
  const [draftVersion, setDraftVersion] = useState<number | undefined>(undefined);
  const [status, setStatus] = useState<Message | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [overlay, setOverlay] = useState<Record<string, NodeOverlay> | undefined>(undefined);

  const { reset } = h;
  const loaded = h.graph !== null;
  useEffect(() => {
    if (flow.data && !loaded) {
      reset(graphOf(flow.data));
      setServerProblems(flow.data.problems ?? []);
      setDraftVersion(flow.data.draft?.version);
    }
  }, [flow.data, loaded, reset]);

  const graph = h.graph;
  const change = (g: BotGraph, opts?: { silent?: boolean }) => {
    h.change(g, opts);
    setDirty(true);
  };

  // Live validation while editing (advisory; Save and Publish validate on the server).
  const tools = meta.data?.tools;
  const problems = useMemo(() => {
    if (!graph || !dirty || !tools) return serverProblems;
    const parsed = BotGraph.safeParse(graph);
    if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join('.') || 'graph'}: ${i.message}`);
    return validateBotGraph(parsed.data, { tools: new Set(tools.map((t) => t.name)), limits: { nodes: MAX_BOT_NODES } });
  }, [graph, dirty, tools, serverProblems]);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['bot', id] });
    await qc.invalidateQueries({ queryKey: ['bots'] });
  };

  const save = async () => {
    if (!graph) return null;
    try {
      const r = await api<{ number: number; version: number; problems: string[] }>(`/api/bots/${id}/draft`, { method: 'PUT', body: { graph, ...(draftVersion !== undefined ? { version: draftVersion } : {}) } });
      setServerProblems(r.problems);
      setDraftVersion(r.version);
      setDirty(false);
      setStatus({ tone: r.problems.length ? 'info' : 'success', text: `Draft v${r.number} saved${r.problems.length ? ` with ${r.problems.length} problem(s) to fix before publishing` : ''}.` });
      await refresh();
      return r;
    } catch (e) {
      setStatus({ tone: 'error', text: errorText(e) });
      return null;
    }
  };

  const addNode = (type: string, from?: { id: string; port: string }) => {
    if (!graph || !meta.data) return;
    const nid = uniqueId(graph, type);
    const src = from ? graph.nodes.find((n) => n.id === from.id) : null;
    const node: BotNode = { id: nid, type: type as BotNode['type'], name: NODE_LABELS[type] ?? type, position: freeSpot(graph, src ? { x: src.position.x + 300, y: src.position.y } : { x: 0, y: 240 }), config: defaultBotConfig(type, meta.data, nid) };
    let g: BotGraph = { ...graph, nodes: [...graph.nodes, node] };
    if (from) g = connect(g, from.id, from.port, nid);
    change(g);
    setSelected(nid);
    setStatus({ tone: 'info', text: `Added ${node.name}.` });
  };

  const removeNode = (nid: string) => {
    if (!graph) return;
    change({ nodes: graph.nodes.filter((n) => n.id !== nid), edges: graph.edges.filter((e) => e.from !== nid && e.to !== nid) });
    if (selected === nid) setSelected(null);
  };

  // Keyboard: undo/redo (not while typing in a field).
  const onKeyDown = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || !graph || !canManage) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) h.redo();
      else h.undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      h.redo();
    }
  };

  if (!allowed) return <EmptyState title="Bot Studio">Ask a Manager or Admin for access to bot flows.</EmptyState>;
  if (flow.error) return <Alert tone="error">{errorText(flow.error)}</Alert>;
  if (!flow.data || !graph || !meta.data) return <p className="text-muted">Loading…</p>;

  const f = flow.data.flow;
  const draft = flow.data.draft as { number: number; version: number } | null;
  const published = flow.data.published as { number: number; service_role: string | null; channels: string[] } | null;
  const selNode = graph.nodes.find((n) => n.id === selected) ?? null;
  const act = async (fn: () => Promise<Message>) => {
    try {
      setStatus(await fn());
      await refresh();
    } catch (e) {
      setStatus({ tone: 'error', text: errorText(e) });
    }
  };

  return (
    <div onKeyDown={onKeyDown}>
      <PageHeader
        title={f.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge value={f.status} />
            <span>
              {draft ? `Editing draft v${draft.number}` : published ? `Viewing published v${published.number}` : 'No version yet'}
              {dirty ? ' · unsaved changes' : ''}
              {published ? ` · live on ${channelNames(published.channels) || 'no channel'}` : ''}
            </span>
          </span>
        }
        actions={
          canManage && (
            <>
              <Button variant="secondary" onPress={save}>
                Save draft
              </Button>
              <Button
                onPress={async () => {
                  const r = await save();
                  if (r) setPublishOpen(true);
                }}
              >
                Publish…
              </Button>
              {draft && (
                <Button
                  variant="secondary"
                  onPress={() =>
                    act(async () => {
                      await api(`/api/bots/${id}/discard`, { body: {} });
                      const fresh = await api(`/api/bots/${id}`);
                      h.reset(graphOf(fresh));
                      setServerProblems(fresh.problems ?? []);
                      setDraftVersion(undefined);
                      setDirty(false);
                      setSelected(null);
                      return { tone: 'success', text: 'Draft discarded.' };
                    })
                  }
                >
                  Discard draft
                </Button>
              )}
              {f.published_number && (
                <Button
                  variant="secondary"
                  onPress={() =>
                    act(async () => {
                      const next = f.status === 'active' ? 'disabled' : 'active';
                      await api(`/api/bots/${id}/status`, { body: { status: next } });
                      return { tone: 'success', text: next === 'active' ? 'The bot flow is enabled.' : 'The bot flow is disabled; conversations go straight to the Inbox.' };
                    })
                  }
                >
                  {f.status === 'active' ? 'Disable' : 'Enable'}
                </Button>
              )}
            </>
          )
        }
      />
      <p className="mb-3">
        <Link to="/bot-studio" className="inline-flex min-h-11 items-center text-accent underline">
          All bot flows
        </Link>
      </p>
      <div aria-live="polite" className="mb-3">
        {status && (
          <Alert tone={status.tone}>
            {status.text}
            {status.details && (
              <ul className="mt-2 list-disc pl-5">
                {status.details.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
          </Alert>
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Editor view" className="flex gap-2">
          <Button variant={view === 'canvas' ? 'primary' : 'secondary'} aria-pressed={view === 'canvas'} onPress={() => setView('canvas')}>
            Canvas
          </Button>
          <Button variant={view === 'outline' ? 'primary' : 'secondary'} aria-pressed={view === 'outline'} onPress={() => setView('outline')}>
            Outline (keyboard)
          </Button>
        </div>
        {canManage && (
          <div role="group" aria-label="Edit" className="flex flex-wrap gap-2">
            <Button variant="secondary" isDisabled={!h.canUndo} onPress={h.undo}>
              Undo
            </Button>
            <Button variant="secondary" isDisabled={!h.canRedo} onPress={h.redo}>
              Redo
            </Button>
            <Button variant="secondary" onPress={() => change(autoLayout(graph))}>
              Auto-layout
            </Button>
          </div>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-4">
          {canManage && <Palette onAdd={(t) => addNode(t, selNode && botOutputPorts(selNode).length ? { id: selNode.id, port: botOutputPorts(selNode)[0]! } : undefined)} />}
          {view === 'canvas' ? (
            <WorkflowCanvas label="Bot flow canvas" graph={graph} problems={problems} selected={selected} onSelect={setSelected} {...(overlay ? { overlay } : {})} {...(canManage ? { onChange: change } : {})} />
          ) : (
            <Outline graph={graph} problems={problems} selected={selected} onSelect={setSelected} onChange={canManage ? change : null} onAdd={addNode} onRemove={removeNode} />
          )}
          {problems.length > 0 && (
            <Card title={`Problems (${problems.length})`}>
              <ul className="list-disc pl-5 text-sm text-bad">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Card>
          )}
        </div>
        <div className="flex flex-col gap-4">
          <Card title={selNode ? `Configure: ${selNode.name}` : 'Configure'}>
            {selNode ? (
              <>
                <BotNodeConfigForm key={selNode.id} node={selNode} meta={meta.data} readOnly={!canManage} onChange={(n) => change({ ...graph, nodes: graph.nodes.map((x) => (x.id === n.id ? n : x)) })} />
                {canManage && selNode.type !== 'start' && (
                  <Button variant="danger" className="mt-3" onPress={() => removeNode(selNode.id)}>
                    Delete node
                  </Button>
                )}
              </>
            ) : (
              <p className="text-sm text-muted">Select a node on the canvas or in the outline to configure it.</p>
            )}
          </Card>
          {canManage && <TestConsole flowId={id} graph={graph} onTrace={setOverlay} />}
          <Versions flowId={id} versions={flow.data.versions} canManage={canManage} onDone={async (m) => {
              setStatus(m);
              await refresh();
            }} />
        </div>
      </div>
      {publishOpen && (
        <PublishDialog
          flowId={id}
          version={draftVersion}
          meta={meta.data}
          onClose={() => setPublishOpen(false)}
          onDone={async (m) => {
            setStatus(m);
            setPublishOpen(false);
            setDraftVersion(undefined);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function Palette(props: { onAdd: (type: string) => void }) {
  return (
    <div role="group" aria-label="Add a node" className="flex flex-wrap gap-2 rounded-xl border border-line bg-white p-3">
      <span className="flex min-h-11 items-center text-sm font-medium">Add:</span>
      {ADDABLE.map((t) => (
        <Button key={t} variant="secondary" onPress={() => props.onAdd(t)}>
          {NODE_LABELS[t]}
        </Button>
      ))}
    </div>
  );
}

/** The accessible editor: an ordered list of nodes and their outputs. */
function Outline(props: {
  graph: BotGraph;
  problems: string[];
  selected: string | null;
  onSelect: (id: string) => void;
  onChange: ((g: BotGraph) => void) | null;
  onAdd: (type: string, from?: { id: string; port: string }) => void;
  onRemove: (id: string) => void;
}) {
  const { graph, onChange } = props;
  const byNode = problemsByNode(props.problems);
  const nodes = orderedNodes(graph);
  const [addType, setAddType] = useState<string>('message');
  const [addFrom, setAddFrom] = useState<string>('');
  const sources = nodes.flatMap((n) => botOutputPorts(n).map((port) => ({ id: `${n.id}:${port}`, label: `${n.name} → ${port}` })));
  const setTarget = (from: string, port: string, to: string) => {
    if (!onChange) return;
    const without = { ...graph, edges: graph.edges.filter((e) => !(e.from === from && e.port === port)) };
    onChange(to === '' ? without : connect(without, from, port, to));
  };
  return (
    <section aria-label="Bot flow outline" className="rounded-xl border border-line bg-white p-4">
      <ol className="flex flex-col gap-4">
        {nodes.map((n, i) => {
          const ports = botOutputPorts(n);
          const problems = byNode.get(n.id) ?? [];
          const others = graph.nodes.filter((x) => x.id !== n.id && x.type !== 'start');
          return (
            <li key={n.id} className={`rounded-lg border p-3 ${props.selected === n.id ? 'border-accent' : 'border-line'}`} aria-label={describeNode(n, problems)}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold">
                  {i + 1}. {n.name} <span className="text-sm font-normal text-muted">({NODE_LABELS[n.type]})</span>
                </h3>
                <div className="flex gap-2">
                  <Button variant="secondary" aria-label={`Configure ${n.name}`} onPress={() => props.onSelect(n.id)}>
                    Configure
                  </Button>
                  {onChange && n.type !== 'start' && (
                    <Button variant="danger" aria-label={`Delete ${n.name}`} onPress={() => props.onRemove(n.id)}>
                      Delete
                    </Button>
                  )}
                </div>
              </div>
              {problems.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-sm text-bad">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              {ports.length === 0 ? (
                <p className="mt-2 text-sm text-muted">Ends the flow: the conversation moves to the Inbox.</p>
              ) : (
                <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                  {ports.map((port) => {
                    const target = graph.edges.find((e) => e.from === n.id && e.port === port)?.to ?? '';
                    return (
                      <li key={port}>
                        <Select label={`${n.name}: output “${port}” goes to`} value={target} isDisabled={!onChange} onChange={(to) => setTarget(n.id, port, to)} options={[{ id: '', label: '(nothing — the flow ends)' }, ...others.map((x) => ({ id: x.id, label: x.name }))]} />
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      {onChange && (
        <form
          className="mt-4 grid items-end gap-2 border-t border-line pt-4 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            const [fromId, port] = addFrom.split(':');
            props.onAdd(addType, fromId && port ? { id: fromId, port } : undefined);
          }}
        >
          <Select label="New node type" value={addType} onChange={setAddType} options={ADDABLE.map((t) => ({ id: t as string, label: NODE_LABELS[t]! }))} />
          <Select label="Connect it after" value={addFrom} onChange={setAddFrom} options={[{ id: '', label: '(not connected)' }, ...sources]} />
          <Button type="submit">Add node</Button>
        </form>
      )}
    </section>
  );
}

function PublishDialog(props: { flowId: string; version: number | undefined; meta: BotMeta; onClose: () => void; onDone: (m: Message) => void }) {
  const [role, setRole] = useState(props.meta.roles.some((r) => r.id === 'Viewer') ? 'Viewer' : (props.meta.roles[0]?.id ?? 'Viewer'));
  const [error, setError] = useState<{ text: string; details?: string[] } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api<{ number: number }>(`/api/bots/${props.flowId}/publish`, { body: { version: props.version, service_role: role } });
      props.onDone({ tone: 'success', text: `Published v${r.number}. The bot looks things up as ${props.meta.roles.find((x) => x.id === role)?.name ?? role}.` });
    } catch (err) {
      const d = err instanceof ApiError ? ((err.details as any)?.problems ?? (err.details as any)?.missing ?? (err.details as any)?.extra) : undefined;
      setError({ text: errorText(err), ...(Array.isArray(d) ? { details: d.map(String) } : {}) });
    }
  };
  return (
    <ModalDialog title="Publish bot flow" isOpen onOpenChange={(o) => !o && props.onClose()}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Select label="The bot looks things up as" value={role} onChange={setRole} options={props.meta.roles.map((r) => ({ id: r.id, label: r.name }))} />
        <p className="text-sm text-muted">Lookups run with this role's permissions, never more than yours, and never return personal data. Once published, the flow answers new customer messages on its channels.</p>
        {error && (
          <Alert tone="error">
            {error.text}
            {error.details && (
              <ul className="mt-2 list-disc pl-5">
                {error.details.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
          </Alert>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onPress={props.onClose}>
            Cancel
          </Button>
          <Button type="submit">Publish</Button>
        </div>
      </form>
    </ModalDialog>
  );
}

function Versions(props: { flowId: string; versions: any[]; canManage: boolean; onDone: (m: Message) => void }) {
  return (
    <Card title="Versions">
      <ul className="flex flex-col divide-y divide-line text-sm">
        {props.versions.map((v) => (
          <li key={v.number} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              v{v.number} <Badge value={v.status} /> {v.published_at ? dateTime(v.published_at) : ''} {v.service_role ? `· as ${v.service_role}` : ''} {v.note ? `· ${v.note}` : ''}
            </span>
            {props.canManage && v.status === 'superseded' && (
              <Button
                variant="secondary"
                aria-label={`Restore version ${v.number}`}
                onPress={async () => {
                  try {
                    const r = await api<{ number: number }>(`/api/bots/${props.flowId}/rollback`, { body: { number: v.number } });
                    props.onDone({ tone: 'success', text: `Version ${v.number} re-published as v${r.number}.` });
                  } catch (e) {
                    props.onDone({ tone: 'error', text: errorText(e) });
                  }
                }}
              >
                Restore
              </Button>
            )}
          </li>
        ))}
      </ul>
      {props.versions.length === 0 && <p className="text-sm text-muted">No versions yet.</p>}
    </Card>
  );
}

interface TestLine {
  from: 'you' | 'bot' | 'system';
  text: string;
  citations?: { n: number; title: string }[];
}

/** Runs customer messages through the graph being edited. Nothing is stored or sent. */
function TestConsole(props: { flowId: string; graph: BotGraph; onTrace: (o: Record<string, NodeOverlay> | undefined) => void }) {
  const start = props.graph.nodes.find((n) => n.type === 'start');
  const offered = ((start?.config.channels as BotChannel[] | undefined) ?? []).filter((c) => (BOT_CHANNELS as readonly string[]).includes(c));
  const [channel, setChannel] = useState<BotChannel>(offered[0] ?? 'widget');
  const [text, setText] = useState('');
  const [session, setSession] = useState<unknown>(null);
  const [lines, setLines] = useState<TestLine[]>([]);
  const [trace, setTrace] = useState<{ node_id: string; port: string | null; detail: Record<string, unknown> }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { onTrace } = props;

  const restart = () => {
    setSession(null);
    setLines([]);
    setTrace([]);
    setError(null);
    onTrace(undefined);
  };
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ messages: { text: string; citations?: { n: number; title: string }[] }[]; handoff: { reason: string } | null; trace: { node_id: string; port: string | null; detail: Record<string, unknown> }[]; session: unknown; ended: boolean }>(`/api/bots/${props.flowId}/test`, {
        body: { graph: props.graph, text: message, channel, ...(session ? { session } : {}) },
      });
      setLines((prev) => [
        ...prev,
        { from: 'you', text: message },
        ...r.messages.map((m): TestLine => ({ from: 'bot', text: m.text, ...(m.citations?.length ? { citations: m.citations } : {}) })),
        ...(r.handoff ? [{ from: 'system' as const, text: `Handed off to the Inbox: ${r.handoff.reason}` }] : r.ended ? [{ from: 'system' as const, text: 'Flow ended' }] : []),
      ]);
      setSession(r.session);
      setTrace(r.trace);
      onTrace(Object.fromEntries(r.trace.map((s) => [s.node_id, { status: s.detail.error ? 'failed' : s.detail.waiting ? 'waiting' : 'succeeded', port: s.port, error: s.detail.error ? String(s.detail.error) : null }])));
      setText('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Test console">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">Try the flow as a customer. Nothing is stored or sent; lookups and the assistant run with your own permissions.</p>
        <div role="log" aria-live="polite" aria-label="Test conversation" tabIndex={0} className="flex max-h-72 min-h-16 flex-col gap-2 overflow-y-auto rounded-lg border border-line bg-ground p-3 text-sm">
          {lines.length === 0 && <p className="text-muted">No messages yet.</p>}
          {lines.map((l, i) => (
            <div key={i} className={l.from === 'you' ? 'ml-6 rounded-lg bg-accent-soft p-2' : l.from === 'bot' ? 'mr-6 rounded-lg border border-line bg-white p-2' : 'rounded-lg bg-warn-soft p-2 text-ink'}>
              <p className="text-xs font-semibold text-muted">{l.from === 'you' ? 'You (as a customer)' : l.from === 'bot' ? 'Bot' : 'Result'}</p>
              <p className="whitespace-pre-wrap break-words">{l.text}</p>
              {l.citations && <p className="mt-1 text-xs text-muted">Sources: {l.citations.map((c) => `[${c.n}] ${c.title}`).join('; ')}</p>}
            </div>
          ))}
        </div>
        <form onSubmit={send} className="flex flex-col gap-3">
          <TextField label="Test message" value={text} onChange={setText} />
          <Select label="Channel" value={channel} onChange={setChannel} options={BOT_CHANNELS.map((c) => ({ id: c, label: CHANNEL_LABELS[c] }))} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" isDisabled={!text.trim() || busy}>
              Send test message
            </Button>
            <Button variant="secondary" onPress={restart}>
              Restart
            </Button>
          </div>
        </form>
        {error && <Alert tone="error">{error}</Alert>}
        {trace.length > 0 && (
          <div>
            <h3 className="mb-1 text-sm font-semibold">Steps of the last message</h3>
            <ol aria-label="Test steps" className="flex flex-col gap-1 text-sm">
              {trace.map((s, i) => (
                <li key={i} className="rounded-lg border border-line p-2">
                  <span className="font-medium">{props.graph.nodes.find((n) => n.id === s.node_id)?.name ?? s.node_id}</span> <code className="text-xs">{s.node_id}</code>
                  {s.port ? <span className="text-muted"> → {s.port}</span> : s.detail.waiting ? <span className="text-muted"> · waiting for the answer</span> : null}
                  {typeof s.detail.count === 'number' && <span className="text-muted"> · {s.detail.count} result(s)</span>}
                  {s.detail.error ? <p className="text-bad">{String(s.detail.error)}</p> : null}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </Card>
  );
}
