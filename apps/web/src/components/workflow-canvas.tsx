import { outputPorts, type WorkflowGraph, type WorkflowNode } from '@aod/shared';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

/**
 * The n8n-style canvas, our own implementation on React Flow. Nodes are focusable
 * (Tab), selectable (Enter) and movable with the arrow keys; every output port is
 * labelled with visible text. The outline view offers the same editing by keyboard
 * and screen reader.
 */

export const NODE_LABELS: Record<string, string> = {
  trigger: 'Trigger',
  condition: 'Condition',
  switch: 'Switch',
  command: 'App command',
  record: 'Record',
  hub_send: 'Send via Hub',
  notify: 'Notify',
  wait: 'Wait',
  approval: 'Approval',
  set: 'Set variables',
  code: 'Code',
  parallel: 'Parallel',
  merge: 'Merge',
};

export interface NodeOverlay {
  status: string;
  port?: string | null;
  error?: string | null;
}

interface WfNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  problems: string[];
  overlay: NodeOverlay | null;
}

const statusRing: Record<string, string> = {
  succeeded: 'border-ok',
  failed: 'border-bad',
  waiting: 'border-warn',
  running: 'border-accent',
  pending: 'border-accent',
  cancelled: 'border-muted',
};

const WfNode = memo(function WfNode({ data, selected }: NodeProps<Node<WfNodeData>>) {
  const { node, problems, overlay } = data;
  const ports = outputPorts(node);
  const ring = problems.length ? 'border-bad' : overlay ? (statusRing[overlay.status] ?? 'border-line') : 'border-line';
  return (
    <div className={`w-56 rounded-lg border-2 bg-white text-left shadow-sm ${ring} ${selected ? 'outline-2 outline-offset-2 outline-accent' : ''}`}>
      {node.type !== 'trigger' && <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border-2 !border-white !bg-muted" />}
      <div className="border-b border-line px-3 py-1.5 text-xs font-medium text-muted">{NODE_LABELS[node.type] ?? node.type}</div>
      <div className="px-3 py-2">
        <p className="text-sm font-semibold text-ink">{node.name}</p>
        {overlay && (
          <p className="mt-1 text-xs text-ink">
            {overlay.status}
            {overlay.port ? ` → ${overlay.port}` : ''}
          </p>
        )}
        {problems.length > 0 && <p className="mt-1 text-xs font-medium text-bad">{problems.length === 1 ? problems[0] : `${problems.length} problems`}</p>}
      </div>
      <div className="flex flex-col gap-1 pb-2">
        {ports.map((port) => (
          <div key={port} className="relative flex justify-end pr-4 text-xs text-muted">
            {port}
            <Handle type="source" id={port} position={Position.Right} className="!h-3 !w-3 !border-2 !border-white !bg-accent" style={{ top: '50%' }} />
          </div>
        ))}
      </div>
    </div>
  );
});

const nodeTypes = { wf: WfNode };

/** Re-fits the view when nodes are added or removed, so new nodes are never off-screen. */
function FitOnCountChange({ count }: { count: number }) {
  const rf = useReactFlow();
  const last = useRef(count);
  useEffect(() => {
    if (last.current === count) return;
    last.current = count;
    const t = setTimeout(() => void rf.fitView({ padding: 0.2, maxZoom: 1, duration: 0 }), 50);
    return () => clearTimeout(t);
  }, [count, rf]);
  return null;
}

/** First free spot at or below `want` (no node within a node's footprint). */
export function freeSpot(g: WorkflowGraph, want: { x: number; y: number }) {
  const p = { ...want };
  while (g.nodes.some((n) => Math.abs(n.position.x - p.x) < 240 && Math.abs(n.position.y - p.y) < 160)) p.y += 180;
  return p;
}

/** Problems of the validator are prefixed with the node id. */
export function problemsByNode(problems: string[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const p of problems) {
    const id = /^([a-z][a-z0-9_]*)[: ]/.exec(p)?.[1];
    if (id) m.set(id, [...(m.get(id) ?? []), p.slice(id.length).replace(/^[: ]+/, '')]);
  }
  return m;
}

export function describeNode(n: WorkflowNode, problems: string[] = []) {
  const ports = outputPorts(n);
  return `${NODE_LABELS[n.type] ?? n.type} node ${n.name}. Outputs: ${ports.join(', ')}.${problems.length ? ` ${problems.length} problem(s).` : ''}`;
}

/** Layered layout: column = longest path from the trigger, rows in order of discovery. */
export function autoLayout(g: WorkflowGraph): WorkflowGraph {
  const depth = new Map<string, number>();
  const trigger = g.nodes.find((n) => n.type === 'trigger');
  if (trigger) depth.set(trigger.id, 0);
  for (let i = 0; i < g.nodes.length; i++) {
    for (const e of g.edges) {
      const d = depth.get(e.from);
      if (d !== undefined && (depth.get(e.to) ?? -1) < d + 1) depth.set(e.to, d + 1);
    }
  }
  const rows = new Map<number, number>();
  const maxDepth = Math.max(0, ...depth.values());
  return {
    ...g,
    nodes: g.nodes.map((n) => {
      const d = depth.get(n.id) ?? maxDepth + 1;
      const row = rows.get(d) ?? 0;
      rows.set(d, row + 1);
      return { ...n, position: { x: d * 300, y: row * 180 } };
    }),
  };
}

export function WorkflowCanvas(props: {
  graph: WorkflowGraph;
  problems?: string[];
  overlay?: Record<string, NodeOverlay>;
  /** edges taken in a run (execution view) */
  taken?: Set<string>;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  /** omitted: read-only */
  onChange?: (g: WorkflowGraph, opts?: { silent?: boolean }) => void;
  label: string;
}) {
  const { graph, onChange } = props;
  const byNode = useMemo(() => problemsByNode(props.problems ?? []), [props.problems]);
  // Controlled mode: keep React Flow's measured sizes (minimap, fit view, handles).
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const nodes: Node<WfNodeData>[] = graph.nodes.map((n) => ({
    id: n.id,
    type: 'wf',
    position: n.position,
    selected: props.selected === n.id,
    ariaLabel: describeNode(n, byNode.get(n.id)),
    ...(measured[n.id] ? { measured: measured[n.id] } : {}),
    data: { node: n, problems: byNode.get(n.id) ?? [], overlay: props.overlay?.[n.id] ?? null },
    deletable: Boolean(onChange) && n.type !== 'trigger',
  }));
  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.from,
    sourceHandle: e.port,
    target: e.to,
    label: e.port === 'out' ? undefined : e.port,
    ariaLabel: `From ${e.from} output ${e.port} to ${e.to}`,
    animated: props.taken?.has(e.id) ?? false,
    style: props.taken ? { stroke: props.taken.has(e.id) ? '#146c43' : '#c4c9d1', strokeWidth: props.taken.has(e.id) ? 3 : 1.5 } : { strokeWidth: 1.5 },
    labelStyle: { fill: '#1b1f27', fontSize: 12 },
    labelBgStyle: { fill: '#ffffff' },
  }));

  const onNodesChange = (changes: NodeChange[]) => {
    const dims = changes.filter((c): c is Extract<NodeChange, { type: 'dimensions' }> => c.type === 'dimensions' && Boolean(c.dimensions));
    if (dims.length) setMeasured((m) => ({ ...m, ...Object.fromEntries(dims.map((c) => [c.id, c.dimensions!])) }));
    const selects = changes.filter((c): c is Extract<NodeChange, { type: 'select' }> => c.type === 'select');
    if (selects.length) {
      const picked = selects.find((c) => c.selected);
      if (picked) props.onSelect?.(picked.id);
      else if (selects.some((c) => c.id === props.selected)) props.onSelect?.(null);
    }
    if (!onChange) return;
    let g = graph;
    let silent = true;
    for (const c of changes) {
      if (c.type === 'position' && c.position) {
        g = { ...g, nodes: g.nodes.map((n) => (n.id === c.id ? { ...n, position: { x: Math.round(c.position!.x), y: Math.round(c.position!.y) } } : n)) };
        if (!c.dragging) silent = false;
      }
      if (c.type === 'remove') {
        g = { nodes: g.nodes.filter((n) => n.id !== c.id), edges: g.edges.filter((e) => e.from !== c.id && e.to !== c.id) };
        silent = false;
      }
    }
    if (g !== graph) onChange(g, { silent });
  };
  const onEdgesChange = (changes: EdgeChange[]) => {
    if (!onChange) return;
    const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id));
    if (removed.size) onChange({ ...graph, edges: graph.edges.filter((e) => !removed.has(e.id)) });
  };
  const onConnect = (c: Connection) => {
    if (!onChange || !c.source || !c.target || c.source === c.target) return;
    onChange(connect(graph, c.source, c.sourceHandle ?? 'out', c.target));
  };

  return (
    <div className="h-[560px] w-full overflow-hidden rounded-xl border border-line bg-white" role="region" aria-label={props.label}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onPaneClick={() => props.onSelect?.(null)}
          nodesDraggable={Boolean(onChange)}
          nodesConnectable={Boolean(onChange)}
          elementsSelectable
          nodesFocusable
          edgesFocusable={Boolean(onChange)}
          deleteKeyCode={onChange ? ['Backspace', 'Delete'] : null}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
          ariaLabelConfig={{ 'node.a11yDescription.default': 'Press Enter or Space to select the node. Use the arrow keys to move it; Delete removes it.' }}
        >
          <Background gap={20} color="#e3e6eb" />
          <MiniMap ariaLabel="Workflow minimap" pannable zoomable nodeColor="#c9d6f7" nodeStrokeColor="#2856d9" maskColor="rgba(246, 247, 249, 0.6)" />
          <FitOnCountChange count={graph.nodes.length} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

/** Connects `from:port` to `to`; a port feeds one node, except a parallel node's branches. */
export function connect(g: WorkflowGraph, from: string, port: string, to: string): WorkflowGraph {
  const src = g.nodes.find((n) => n.id === from);
  if (!src || g.edges.some((e) => e.from === from && e.port === port && e.to === to)) return g;
  const keep = src.type === 'parallel' ? g.edges : g.edges.filter((e) => !(e.from === from && e.port === port));
  let i = g.edges.length + 1;
  while (g.edges.some((e) => e.id === `e${i}`)) i++;
  return { ...g, edges: [...keep, { id: `e${i}`, from, port, to }] };
}

/** Nodes in reading order: breadth-first from the trigger, then anything unreachable. */
export function orderedNodes(g: WorkflowGraph): WorkflowNode[] {
  const out: WorkflowNode[] = [];
  const seen = new Set<string>();
  const trigger = g.nodes.find((n) => n.type === 'trigger');
  const queue = trigger ? [trigger.id] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = g.nodes.find((x) => x.id === id);
    if (n) out.push(n);
    for (const e of g.edges.filter((x) => x.from === id)) queue.push(e.to);
  }
  return [...out, ...g.nodes.filter((n) => !seen.has(n.id))];
}
