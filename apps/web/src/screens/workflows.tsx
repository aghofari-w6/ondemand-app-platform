import { NODE_TYPES, outputPorts, type WorkflowGraph, type WorkflowNode } from '@aod/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { can, useMe } from '../components/shell';
import { Alert, Badge, Button, Card, EmptyState, ModalDialog, PageHeader, Select, TextArea, TextField } from '../components/ui';
import { autoLayout, connect, describeNode, freeSpot, NODE_LABELS, orderedNodes, problemsByNode, WorkflowCanvas, type NodeOverlay } from '../components/workflow-canvas';
import { defaultConfig, NodeConfigForm, type WorkflowMeta } from '../components/workflow-forms';
import { api, ApiError, dateTime } from '../lib/api';

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));
const useMeta = () => useQuery<WorkflowMeta>({ queryKey: ['workflow-meta'], queryFn: () => api('/api/workflows/meta'), staleTime: 30_000 });

// ------------------------------------------------------------------ list + run DLQ

export function WorkflowsScreen() {
  const me = useMe();
  const [tab, setTab] = useState<'workflows' | 'failed'>('workflows');
  if (!can(me.data, 'platform:workflows.read')) return <EmptyState title="Workflows">Ask a Manager or Admin for access to workflows.</EmptyState>;
  return (
    <>
      <PageHeader title="Workflows" description="Automations that run when something happens in your apps. Build them on the canvas or in the outline." />
      <div role="group" aria-label="Sections" className="mb-4 flex flex-wrap gap-2">
        <Button variant={tab === 'workflows' ? 'primary' : 'secondary'} aria-pressed={tab === 'workflows'} onPress={() => setTab('workflows')}>
          Workflows
        </Button>
        <Button variant={tab === 'failed' ? 'primary' : 'secondary'} aria-pressed={tab === 'failed'} onPress={() => setTab('failed')}>
          Failed runs
        </Button>
      </div>
      {tab === 'workflows' ? <WorkflowList /> : <FailedRuns />}
    </>
  );
}

function WorkflowList() {
  const me = useMe();
  const list = useQuery({ queryKey: ['workflows'], queryFn: () => api('/api/workflows'), refetchInterval: 5000 });
  const [open, setOpen] = useState(false);
  return (
    <Card title="All workflows">
      {can(me.data, 'platform:workflows.manage') && (
        <Button className="mb-3" onPress={() => setOpen(true)}>
          New workflow
        </Button>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Workflows</caption>
          <thead className="text-muted">
            <tr>
              <th scope="col" className="py-2 font-medium">Name</th>
              <th scope="col" className="py-2 font-medium">Status</th>
              <th scope="col" className="py-2 font-medium">Trigger</th>
              <th scope="col" className="py-2 font-medium">Published</th>
              <th scope="col" className="py-2 font-medium">Runs (30 days)</th>
              <th scope="col" className="py-2 font-medium">Last run</th>
            </tr>
          </thead>
          <tbody>
            {(list.data?.workflows ?? []).map((w: any) => (
              <tr key={w.id} className="border-t border-line">
                <td className="py-2">
                  <Link to={`/workflows/${w.id}`} className="inline-flex min-h-11 items-center font-medium text-accent underline">
                    {w.name}
                  </Link>
                </td>
                <td className="py-2">
                  <Badge value={w.status} />
                  {w.draft && <span className="ml-2 text-xs text-muted">draft open</span>}
                </td>
                <td className="py-2">{w.published?.trigger_event ?? w.draft?.trigger_event ?? '—'}</td>
                <td className="py-2">{w.published ? `v${w.published.number} as ${w.published.service_role}` : '—'}</td>
                <td className="py-2">{Object.entries(w.runs_30d).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}</td>
                <td className="py-2">{dateTime(w.last_run_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.data?.workflows?.length === 0 && <p className="text-muted">No workflows yet. Start from an app template or a blank canvas.</p>}
      {open && <NewWorkflowDialog onClose={() => setOpen(false)} />}
    </Card>
  );
}

function NewWorkflowDialog(props: { onClose: () => void }) {
  const meta = useMeta();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [start, setStart] = useState('blank');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const [app, tname] = start.split('/');
      const r = await api<{ id: string }>('/api/workflows', { body: { name, ...(start !== 'blank' ? { template: { app, name: tname } } : {}) } });
      props.onClose();
      void navigate({ to: `/workflows/${r.id}` });
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <ModalDialog title="New workflow" isOpen onOpenChange={(o) => !o && props.onClose()}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <TextField label="Name" value={name} onChange={setName} isRequired />
        <Select label="Start from" value={start} onChange={setStart} options={[{ id: 'blank', label: 'A blank canvas' }, ...(meta.data?.templates ?? []).map((t) => ({ id: `${t.app}/${t.name}`, label: `Template: ${t.label} (${t.app})` }))]} />
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onPress={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" isDisabled={!name.trim()}>
            Create
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

function FailedRuns() {
  const me = useMe();
  const qc = useQueryClient();
  const runs = useQuery({ queryKey: ['workflow-runs', 'failed'], queryFn: () => api('/api/workflow-runs?status=failed'), refetchInterval: 5000 });
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (id: string, what: 'retry' | 'cancel') => {
    try {
      await api(`/api/workflow-runs/${id}/${what}`, { method: 'POST', body: {} });
      setMsg(what === 'retry' ? 'Retrying from the failed node.' : 'Run cancelled.');
      void qc.invalidateQueries({ queryKey: ['workflow-runs'] });
    } catch (e) {
      setMsg(errorText(e));
    }
  };
  return (
    <Card title="Failed runs">
      {msg && (
        <div className="mb-3">
          <Alert>{msg}</Alert>
        </div>
      )}
      <ul className="flex flex-col divide-y divide-line">
        {(runs.data?.runs ?? []).map((r: any) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div>
              <Link to={`/workflow-runs/${r.id}`} className="inline-flex min-h-11 items-center font-medium text-accent underline">
                {r.name} · {dateTime(r.started_at)}
              </Link>
              <p className="text-sm text-bad">{r.error}</p>
            </div>
            {can(me.data, 'platform:workflows.manage') && (
              <div className="flex gap-2">
                <Button variant="secondary" onPress={() => act(r.id, 'retry')}>
                  Retry from failed node
                </Button>
                <Button variant="danger" onPress={() => act(r.id, 'cancel')}>
                  Cancel run
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {runs.data?.runs?.length === 0 && <p className="text-muted">No failed runs.</p>}
    </Card>
  );
}

// ------------------------------------------------------------------ editor

type View = 'canvas' | 'outline';

function useHistory(initial: WorkflowGraph | null) {
  const [graph, setGraph] = useState<WorkflowGraph | null>(initial);
  const undo = useRef<WorkflowGraph[]>([]);
  const redo = useRef<WorkflowGraph[]>([]);
  const [, bump] = useState(0);
  const change = useCallback((next: WorkflowGraph, opts?: { silent?: boolean }) => {
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
  const reset = (g: WorkflowGraph) => {
    undo.current = [];
    redo.current = [];
    setGraph(g);
  };
  return { graph, change, undo: doUndo, redo: doRedo, canUndo: undo.current.length > 0, canRedo: redo.current.length > 0, reset };
}

const uniqueId = (g: WorkflowGraph, base: string) => {
  let i = 1;
  while (g.nodes.some((n) => n.id === `${base}_${i}`)) i++;
  return `${base}_${i}`;
};

export function WorkflowEditorScreen() {
  const { id } = useParams({ strict: false }) as { id: string };
  const me = useMe();
  const qc = useQueryClient();
  const meta = useMeta();
  const wf = useQuery({ queryKey: ['workflow', id], queryFn: () => api(`/api/workflows/${id}`) });
  const h = useHistory(null);
  const [view, setView] = useState<View>('canvas');
  const [selected, setSelected] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<{ tone: 'info' | 'error' | 'success'; text: string; details?: string[] } | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [clipboard, setClipboard] = useState<WorkflowNode | null>(null);
  const [test, setTest] = useState<any>(null);
  const canManage = can(me.data, 'platform:workflows.manage');

  useEffect(() => {
    if (wf.data?.graph && !h.graph) {
      h.reset(wf.data.graph);
      setProblems(wf.data.problems);
    }
  }, [wf.data, h]);

  const graph = h.graph;
  const change = (g: WorkflowGraph, opts?: { silent?: boolean }) => {
    h.change(g, opts);
    setDirty(true);
  };

  // Validate as you edit (debounced).
  useEffect(() => {
    if (!graph || !dirty) return;
    const t = setTimeout(() => {
      api<{ problems: string[] }>('/api/workflows/validate', { body: { graph } })
        .then((r) => setProblems(r.problems))
        // Live validation is advisory (Save and Publish validate again); keep the last result.
        .catch((e: unknown) => console.warn('live validation failed', e));
    }, 400);
    return () => clearTimeout(t);
  }, [graph, dirty]);

  const save = async () => {
    if (!graph) return;
    try {
      const r = await api<{ number: number; version: number; problems: string[] }>(`/api/workflows/${id}/draft`, { method: 'PUT', body: { graph, ...(wf.data?.current?.status === 'draft' ? { version: wf.data.current.version } : {}) } });
      setProblems(r.problems);
      setDirty(false);
      setStatus({ tone: r.problems.length ? 'info' : 'success', text: `Draft v${r.number} saved${r.problems.length ? ` with ${r.problems.length} problem(s) to fix before publishing` : ''}.` });
      await qc.invalidateQueries({ queryKey: ['workflow', id] });
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
    const node: WorkflowNode = { id: nid, type: type as WorkflowNode['type'], name: NODE_LABELS[type] ?? type, position: freeSpot(graph, src ? { x: src.position.x + 300, y: src.position.y } : { x: 0, y: 240 }), config: defaultConfig(type, meta.data, graph) };
    let g: WorkflowGraph = { ...graph, nodes: [...graph.nodes, node] };
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

  // Keyboard: undo/redo, copy/paste (not while typing in a field).
  const onKeyDown = (e: React.KeyboardEvent) => {
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
    } else if (mod && e.key.toLowerCase() === 'c' && selected) {
      const n = graph.nodes.find((x) => x.id === selected);
      if (n && n.type !== 'trigger') setClipboard(n);
    } else if (mod && e.key.toLowerCase() === 'v' && clipboard) {
      e.preventDefault();
      const nid = uniqueId(graph, clipboard.type);
      change({ ...graph, nodes: [...graph.nodes, { ...clipboard, id: nid, name: `${clipboard.name} (copy)`, position: { x: clipboard.position.x + 40, y: clipboard.position.y + 40 } }] });
      setSelected(nid);
    }
  };

  if (!can(me.data, 'platform:workflows.read')) return <EmptyState title="Workflows">Ask a Manager or Admin for access to workflows.</EmptyState>;
  if (wf.error) return <Alert tone="error">{errorText(wf.error)}</Alert>;
  if (!wf.data || !graph || !meta.data) return <p className="text-muted">Loading…</p>;

  const w = wf.data.workflow;
  const selNode = graph.nodes.find((n) => n.id === selected) ?? null;
  const overlay: Record<string, NodeOverlay> | undefined = test?.steps ? Object.fromEntries(test.steps.map((s: any) => [s.node, { status: s.status, port: s.port, error: s.error }])) : undefined;

  return (
    <div onKeyDown={onKeyDown}>
      <PageHeader
        title={w.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge value={w.status} />
            {wf.data.current && (
              <span>
                Editing v{wf.data.current.number} ({wf.data.current.status}){dirty ? ' · unsaved changes' : ''}
              </span>
            )}
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
              {w.published_number && (
                <Button
                  variant="secondary"
                  onPress={async () => {
                    try {
                      await api(`/api/workflows/${id}/status`, { body: { status: w.status === 'active' ? 'disabled' : 'active' } });
                      await qc.invalidateQueries({ queryKey: ['workflow', id] });
                    } catch (e) {
                      setStatus({ tone: 'error', text: errorText(e) });
                    }
                  }}
                >
                  {w.status === 'active' ? 'Disable' : 'Enable'}
                </Button>
              )}
            </>
          )
        }
      />
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
          {canManage && <Palette onAdd={(t) => addNode(t, selNode && outputPorts(selNode).length ? { id: selNode.id, port: outputPorts(selNode)[0]! } : undefined)} />}
          {view === 'canvas' ? (
            <WorkflowCanvas label="Workflow canvas" graph={graph} problems={problems} overlay={overlay} selected={selected} onSelect={setSelected} {...(canManage ? { onChange: change } : {})} />
          ) : (
            <Outline graph={graph} problems={problems} meta={meta.data} selected={selected} onSelect={setSelected} onChange={canManage ? change : null} onAdd={addNode} onRemove={removeNode} />
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
                <NodeConfigForm key={selNode.id} node={selNode} graph={graph} meta={meta.data} readOnly={!canManage} onChange={(n) => change({ ...graph, nodes: graph.nodes.map((x) => (x.id === n.id ? n : x)) }, { silent: false })} />
                {canManage && selNode.type !== 'trigger' && (
                  <Button variant="danger" className="mt-3" onPress={() => removeNode(selNode.id)}>
                    Delete node
                  </Button>
                )}
              </>
            ) : (
              <p className="text-sm text-muted">Select a node on the canvas or in the outline to configure it.</p>
            )}
          </Card>
          {canManage && <TestRun workflowId={id} graph={graph} onResult={setTest} result={test} />}
          <Versions workflowId={id} versions={wf.data.versions} canManage={canManage} onDone={(m) => setStatus(m)} />
        </div>
      </div>
      {publishOpen && (
        <PublishDialog
          workflowId={id}
          version={wf.data.current?.version}
          meta={meta.data}
          onClose={() => setPublishOpen(false)}
          onDone={async (m) => {
            setStatus(m);
            setPublishOpen(false);
            await qc.invalidateQueries({ queryKey: ['workflow', id] });
            await qc.invalidateQueries({ queryKey: ['workflows'] });
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
      {NODE_TYPES.filter((t) => t !== 'trigger').map((t) => (
        <Button key={t} variant="secondary" onPress={() => props.onAdd(t)}>
          {NODE_LABELS[t]}
        </Button>
      ))}
    </div>
  );
}

/** The accessible editor: an ordered tree of nodes and their outputs. */
function Outline(props: {
  graph: WorkflowGraph;
  problems: string[];
  meta: WorkflowMeta;
  selected: string | null;
  onSelect: (id: string) => void;
  onChange: ((g: WorkflowGraph) => void) | null;
  onAdd: (type: string, from?: { id: string; port: string }) => void;
  onRemove: (id: string) => void;
}) {
  const { graph, onChange } = props;
  const byNode = problemsByNode(props.problems);
  const nodes = orderedNodes(graph);
  const [addType, setAddType] = useState<string>('approval');
  const [addFrom, setAddFrom] = useState<string>('');
  const sources = nodes.flatMap((n) => outputPorts(n).map((port) => ({ id: `${n.id}:${port}`, label: `${n.name} → ${port}` })));
  const setTarget = (from: string, port: string, to: string) => {
    if (!onChange) return;
    const without = { ...graph, edges: graph.edges.filter((e) => !(e.from === from && e.port === port)) };
    onChange(to === '' ? without : connect(without, from, port, to));
  };
  return (
    <section aria-label="Workflow outline" className="rounded-xl border border-line bg-white p-4">
      <ol className="flex flex-col gap-4">
        {nodes.map((n, i) => {
          const ports = outputPorts(n);
          const problems = byNode.get(n.id) ?? [];
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
                  {onChange && n.type !== 'trigger' && (
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
              <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                {ports.map((port) => {
                  const targets = graph.edges.filter((e) => e.from === n.id && e.port === port).map((e) => e.to);
                  const others = graph.nodes.filter((x) => x.id !== n.id && x.type !== 'trigger');
                  if (n.type === 'parallel') {
                    return (
                      <li key={port} className="sm:col-span-2">
                        <p className="text-sm font-medium">Branches</p>
                        <p className="text-sm text-muted">{targets.map((t) => graph.nodes.find((x) => x.id === t)?.name ?? t).join(', ') || 'none yet'}</p>
                        {onChange && (
                          <Select label={`${n.name}: add a branch to`} value={null} onChange={(to) => onChange(connect(graph, n.id, port, to))} options={others.filter((x) => !targets.includes(x.id)).map((x) => ({ id: x.id, label: x.name }))} />
                        )}
                      </li>
                    );
                  }
                  return (
                    <li key={port}>
                      <Select label={`${n.name}: output “${port}” goes to`} value={targets[0] ?? ''} isDisabled={!onChange} onChange={(to) => setTarget(n.id, port, to)} options={[{ id: '', label: '(nothing — the path ends)' }, ...others.map((x) => ({ id: x.id, label: x.name }))]} />
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ol>
      {onChange && (
        <form
          className="mt-4 grid items-end gap-2 border-t border-line pt-4 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            const [id, port] = addFrom.split(':');
            props.onAdd(addType, id && port ? { id, port } : undefined);
          }}
        >
          <Select label="New node type" value={addType} onChange={setAddType} options={NODE_TYPES.filter((t) => t !== 'trigger').map((t) => ({ id: t, label: NODE_LABELS[t]! }))} />
          <Select label="Connect it after" value={addFrom} onChange={setAddFrom} options={[{ id: '', label: '(not connected)' }, ...sources]} />
          <Button type="submit">Add node</Button>
        </form>
      )}
    </section>
  );
}

function PublishDialog(props: { workflowId: string; version: number | undefined; meta: WorkflowMeta; onClose: () => void; onDone: (m: { tone: 'success'; text: string }) => void }) {
  const [role, setRole] = useState('Manager');
  const [error, setError] = useState<{ text: string; details?: string[] } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api<{ number: number }>(`/api/workflows/${props.workflowId}/publish`, { body: { version: props.version, service_role: role } });
      props.onDone({ tone: 'success', text: `Published v${r.number}. It runs as ${props.meta.roles.find((x) => x.id === role)?.name ?? role}.` });
    } catch (err) {
      const d = err instanceof ApiError ? ((err.details as any)?.problems ?? (err.details as any)?.missing ?? (err.details as any)?.extra) : undefined;
      setError({ text: errorText(err), details: d });
    }
  };
  return (
    <ModalDialog title="Publish workflow" isOpen onOpenChange={(o) => !o && props.onClose()}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Select label="Run as role" value={role} onChange={setRole} options={props.meta.roles.map((r) => ({ id: r.id, label: r.name }))} />
        <p className="text-sm text-muted">The workflow acts with this role's permissions, never more than yours. Commands it runs are audited as the workflow.</p>
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

function TestRun(props: { workflowId: string; graph: WorkflowGraph; result: any; onResult: (r: any) => void }) {
  const trigger = props.graph.nodes.find((n) => n.type === 'trigger');
  const event = String(trigger?.config.event ?? '');
  const samples = useQuery({ queryKey: ['workflow-samples', props.workflowId, event], queryFn: () => api(`/api/workflows/${props.workflowId}/samples?event=${encodeURIComponent(event)}`), enabled: Boolean(event) });
  const [source, setSource] = useState<string>('');
  const [sample, setSample] = useState('{\n  "total": 1500000\n}');
  const [approval, setApproval] = useState<'approved' | 'rejected' | 'expired'>('approved');
  const [error, setError] = useState<string | null>(null);
  const options = [{ id: '', label: 'Sample data (below)' }, ...(samples.data?.events ?? []).map((e: any) => ({ id: e.id, label: `${e.type} · ${dateTime(e.created_at)} · ${String(e.aggregateid).slice(0, 8)}` }))];
  const run = async () => {
    setError(null);
    try {
      const body: any = { graph: props.graph, approval };
      if (source) body.event_id = source;
      else body.sample = { data: JSON.parse(sample) };
      props.onResult(await api(`/api/workflows/${props.workflowId}/test`, { body }));
    } catch (e) {
      setError(e instanceof SyntaxError ? 'Sample data is not valid JSON' : errorText(e));
    }
  };
  const r = props.result;
  return (
    <Card title="Test run">
      <div className="flex flex-col gap-3">
        <Select label="Run against" value={source} onChange={setSource} options={options} />
        {!source && <TextArea label="Sample event data (JSON)" mono rows={5} value={sample} onChange={setSample} />}
        <Select label="Assume approvals are" value={approval} onChange={setApproval} options={[{ id: 'approved', label: 'Approved' }, { id: 'rejected', label: 'Rejected' }, { id: 'expired', label: 'Expired' }]} />
        <p className="text-sm text-muted">Nothing is changed: commands, records, Hub sends and notifications only show what they would do.</p>
        <Button onPress={run}>Run test</Button>
        {error && <Alert tone="error">{error}</Alert>}
        {r && (
          <div aria-live="polite" className="flex flex-col gap-2">
            {!r.matched ? (
              <Alert tone="info">{r.error ?? 'The trigger filter does not match this event, so the workflow would not run.'}</Alert>
            ) : (
              <>
                <Alert tone={r.error ? 'error' : 'success'}>{r.error ? `Failed at ${r.error}` : `Path: ${r.path.join(' → ')}`}</Alert>
                <ol className="flex flex-col gap-2">
                  {r.steps.map((s: any) => (
                    <li key={s.node} className="rounded-lg border border-line p-2 text-sm">
                      <p className="font-medium">
                        {s.node} <Badge value={s.status} /> {s.port && <span className="text-muted">→ {s.port}</span>}
                      </p>
                      {s.error && <p className="text-bad">{s.error}</p>}
                      <details>
                        <summary className="min-h-11 cursor-pointer py-2 text-accent">Input and output</summary>
                        <p className="text-xs font-medium text-muted">Input</p>
                        <pre className="overflow-auto rounded bg-ground p-2 text-xs">{JSON.stringify(s.input, null, 2)}</pre>
                        <p className="text-xs font-medium text-muted">Output</p>
                        <pre className="overflow-auto rounded bg-ground p-2 text-xs">{JSON.stringify(s.output, null, 2)}</pre>
                      </details>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function Versions(props: { workflowId: string; versions: any[]; canManage: boolean; onDone: (m: { tone: 'success' | 'error'; text: string }) => void }) {
  const qc = useQueryClient();
  const runs = useQuery({ queryKey: ['workflow-runs', props.workflowId], queryFn: () => api(`/api/workflow-runs?workflow_id=${props.workflowId}&limit=10`), refetchInterval: 4000 });
  return (
    <Card title="Versions and runs">
      <ul className="flex flex-col divide-y divide-line text-sm">
        {props.versions.map((v) => (
          <li key={v.number} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              v{v.number} <Badge value={v.status} /> {v.published_at ? dateTime(v.published_at) : ''} {v.service_role ? `· as ${v.service_role}` : ''}
            </span>
            {props.canManage && v.status === 'superseded' && (
              <Button
                variant="secondary"
                aria-label={`Roll back to version ${v.number}`}
                onPress={async () => {
                  try {
                    const r = await api<{ number: number }>(`/api/workflows/${props.workflowId}/rollback`, { body: { number: v.number } });
                    props.onDone({ tone: 'success', text: `Version ${v.number} re-published as v${r.number}.` });
                    await qc.invalidateQueries({ queryKey: ['workflow', props.workflowId] });
                  } catch (e) {
                    props.onDone({ tone: 'error', text: errorText(e) });
                  }
                }}
              >
                Roll back
              </Button>
            )}
          </li>
        ))}
      </ul>
      <h3 className="mt-4 mb-1 text-sm font-semibold">Recent runs</h3>
      <ul className="flex flex-col text-sm">
        {(runs.data?.runs ?? []).map((r: any) => (
          <li key={r.id}>
            <Link to={`/workflow-runs/${r.id}`} className="inline-flex min-h-11 items-center gap-2 text-accent underline">
              {dateTime(r.started_at)} <Badge value={r.status} />
            </Link>
          </li>
        ))}
      </ul>
      {runs.data?.runs?.length === 0 && <p className="text-sm text-muted">No runs yet.</p>}
    </Card>
  );
}

// ------------------------------------------------------------------ execution view

export function WorkflowRunScreen() {
  const { runId } = useParams({ strict: false }) as { runId: string };
  const me = useMe();
  const qc = useQueryClient();
  const run = useQuery({ queryKey: ['workflow-run', runId], queryFn: () => api(`/api/workflow-runs/${runId}`), refetchInterval: (q) => (q.state.data?.run?.status === 'running' ? 2000 : false) });
  const [msg, setMsg] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const derived = useMemo(() => {
    if (!run.data) return null;
    const nodes = run.data.nodes as any[];
    const latest = new Map<string, any>();
    for (const n of nodes) latest.set(n.node_id, n);
    const overlay: Record<string, NodeOverlay> = Object.fromEntries([...latest].map(([k, n]) => [k, { status: n.status, port: n.port, error: n.error }]));
    const graph = run.data.graph as WorkflowGraph;
    const taken = new Set(graph.edges.filter((e) => nodes.some((n) => n.node_id === e.from && n.port === e.port) && latest.has(e.to)).map((e) => e.id));
    return { overlay, taken, graph };
  }, [run.data]);
  if (!can(me.data, 'platform:workflows.read')) return <EmptyState title="Workflow run">Ask a Manager or Admin for access to workflows.</EmptyState>;
  if (run.error) return <Alert tone="error">{errorText(run.error)}</Alert>;
  if (!run.data || !derived) return <p className="text-muted">Loading…</p>;
  const r = run.data.run;
  const act = async (what: 'retry' | 'cancel') => {
    try {
      await api(`/api/workflow-runs/${runId}/${what}`, { method: 'POST', body: {} });
      setMsg(what === 'retry' ? 'Retrying from the failed node.' : 'Run cancelled.');
      await qc.invalidateQueries({ queryKey: ['workflow-run', runId] });
    } catch (e) {
      setMsg(errorText(e));
    }
  };
  return (
    <>
      <PageHeader
        title={`Run of ${run.data.workflow.name}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge value={r.status} /> v{r.version_number} · started {dateTime(r.started_at)} · hop {r.hop}
          </span>
        }
        actions={
          <>
            <Link to={`/trace-viewer?q=${encodeURIComponent(r.correlation_id)}`} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-white px-4 text-sm font-medium text-accent">
              Open in Trace viewer
            </Link>
            <Link to={`/workflows/${r.workflow_id}`} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-white px-4 text-sm font-medium text-accent">
              Open workflow
            </Link>
            {can(me.data, 'platform:workflows.manage') && r.status === 'failed' && <Button onPress={() => act('retry')}>Retry from failed node</Button>}
            {can(me.data, 'platform:workflows.manage') && (r.status === 'failed' || r.status === 'running') && (
              <Button variant="danger" onPress={() => act('cancel')}>
                Cancel run
              </Button>
            )}
          </>
        }
      />
      {msg && (
        <div className="mb-3">
          <Alert>{msg}</Alert>
        </div>
      )}
      {r.error && (
        <div className="mb-3">
          <Alert tone="error">{r.error}</Alert>
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <WorkflowCanvas label="Execution path" graph={derived.graph} overlay={derived.overlay} taken={derived.taken} selected={selected} onSelect={setSelected} />
        <Card title="Node executions">
          <ol className="flex flex-col gap-2">
            {(run.data.nodes as any[]).map((n) => (
              <li key={n.id} className={`rounded-lg border p-2 text-sm ${selected === n.node_id ? 'border-accent' : 'border-line'}`}>
                <p className="font-medium">
                  {n.node_id} <Badge value={n.status} /> {n.port && <span className="text-muted">→ {n.port}</span>}
                </p>
                <p className="text-xs text-muted">
                  {n.started_at ? dateTime(n.started_at) : 'not started'}
                  {n.started_at && n.finished_at ? ` · ${Math.max(0, new Date(n.finished_at).getTime() - new Date(n.started_at).getTime())} ms` : ''}
                  {n.attempt > 1 ? ` · attempt ${n.attempt}` : ''}
                </p>
                {n.error && <p className="text-bad">{n.error}</p>}
                {run.data.approvals.find((a: any) => a.source_ref === n.id) && (
                  <Link to="/approvals" className="inline-flex min-h-11 items-center text-accent underline">
                    Approval: {run.data.approvals.find((a: any) => a.source_ref === n.id).status}
                  </Link>
                )}
                <details>
                  <summary className="min-h-11 cursor-pointer py-2 text-accent">Input and output</summary>
                  <p className="text-xs font-medium text-muted">Input</p>
                  <pre className="overflow-auto rounded bg-ground p-2 text-xs">{JSON.stringify(n.input, null, 2)}</pre>
                  <p className="text-xs font-medium text-muted">Output</p>
                  <pre className="overflow-auto rounded bg-ground p-2 text-xs">{JSON.stringify(n.output, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
