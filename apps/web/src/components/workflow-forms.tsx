import { outputPorts, type WorkflowGraph, type WorkflowNode } from '@aod/shared';
import { useState } from 'react';
import { Button, Checkbox, Select, TextArea, TextField } from './ui';
import { NODE_LABELS } from './workflow-canvas';

/** What the editor knows about the workspace (GET /api/workflows/meta). */
export interface WorkflowMeta {
  events: { type: string; app: string; description: string; data: string[] }[];
  commands: { app: string; command: string; description: string; permission: string; may_emit: string[]; input: { properties?: Record<string, { type?: string; description?: string }>; required?: string[] } }[];
  entities: { key: string; label: string; fields: { key: string; label: string; type: string }[] }[];
  endpoints: { id: string; name: string; kind: string }[];
  roles: { id: string; name: string }[];
  users: { id: string; name: string; role: string }[];
  templates: { app: string; name: string; label: string; trigger: string }[];
}

type Cfg = Record<string, any>;

/** Literal text stays a string; numbers and booleans typed into number/boolean fields are converted. */
function coerce(raw: string, type: string | undefined): unknown {
  if (raw.includes('{{')) return raw;
  if ((type === 'number' || type === 'integer') && raw.trim() !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  if (type === 'boolean' && (raw === 'true' || raw === 'false')) return raw === 'true';
  if ((type === 'object' || type === 'array') && raw.trim()) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}
const show = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

function JsonField(props: { label: string; value: unknown; onChange: (v: unknown) => void; description?: string }) {
  const [text, setText] = useState(() => JSON.stringify(props.value ?? {}, null, 2));
  const [error, setError] = useState<string | undefined>();
  return (
    <TextArea
      label={props.label}
      mono
      rows={6}
      value={text}
      description={props.description}
      error={error}
      onChange={(t) => {
        setText(t);
        try {
          props.onChange(JSON.parse(t));
          setError(undefined);
        } catch {
          setError('Not valid JSON yet');
        }
      }}
    />
  );
}

function RolePicker(props: { label: string; roles: WorkflowMeta['roles']; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="flex flex-col">
      <legend className="text-sm font-medium text-ink">{props.label}</legend>
      <div className="flex flex-wrap gap-x-4">
        {props.roles.map((r) => (
          <Checkbox key={r.id} isSelected={props.value.includes(r.id)} onChange={(on) => props.onChange(on ? [...props.value, r.id] : props.value.filter((x) => x !== r.id))}>
            {r.name}
          </Checkbox>
        ))}
      </div>
    </fieldset>
  );
}

const TEMPLATE_HINT = 'Use {{ trigger.data.field }}, {{ steps.<node>.output.field }} or {{ vars.name }}.';

export function NodeConfigForm(props: { node: WorkflowNode; graph: WorkflowGraph; meta: WorkflowMeta; onChange: (n: WorkflowNode) => void; readOnly?: boolean }) {
  const { node, meta } = props;
  const c = node.config as Cfg;
  const set = (patch: Cfg) => props.onChange({ ...node, config: { ...c, ...patch } });
  const field = (label: string, key: string, extra: { description?: string; type?: string } = {}) => (
    <TextField label={label} value={show(c[key])} description={extra.description} onChange={(v) => set({ [key]: extra.type ? coerce(v, extra.type) : v })} />
  );

  let body: React.ReactNode = null;
  switch (node.type) {
    case 'trigger': {
      const ev = meta.events.find((e) => e.type === c.event);
      body = (
        <>
          <Select label="When this event happens" value={c.event ?? null} onChange={(v) => set({ event: v })} options={meta.events.map((e) => ({ id: e.type, label: `${e.type} (${e.app})` }))} />
          {ev && <p className="text-sm text-muted">Data: {ev.data.join(', ') || '—'}</p>}
          <TextField label="Only if (filter)" value={c.filter ?? ''} description="An expression, e.g. trigger.data.total > 1000000. Leave empty for every event." onChange={(v) => props.onChange({ ...node, config: v ? { ...c, filter: v } : Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'filter')) })} />
        </>
      );
      break;
    }
    case 'condition':
      body = field('Condition', 'expr', { description: 'True takes the "true" output, otherwise "false". E.g. trigger.data.tender == \'card\'' });
      break;
    case 'switch': {
      const cases = (c.cases ?? []) as { port: string; expr: string }[];
      body = (
        <>
          {cases.map((k, i) => (
            <div key={i} className="grid grid-cols-[1fr_2fr_auto] items-end gap-2">
              <TextField label={`Case ${i + 1} output`} value={k.port} onChange={(v) => set({ cases: cases.map((x, j) => (j === i ? { ...x, port: v } : x)) })} />
              <TextField label={`Case ${i + 1} condition`} value={k.expr} onChange={(v) => set({ cases: cases.map((x, j) => (j === i ? { ...x, expr: v } : x)) })} />
              <Button variant="secondary" aria-label={`Remove case ${i + 1}`} onPress={() => set({ cases: cases.filter((_, j) => j !== i) })}>
                Remove
              </Button>
            </div>
          ))}
          <Button variant="secondary" onPress={() => set({ cases: [...cases, { port: `case_${cases.length + 1}`, expr: 'true' }] })}>
            Add case
          </Button>
        </>
      );
      break;
    }
    case 'command': {
      const cmd = meta.commands.find((x) => x.app === c.app && x.command === c.command);
      const input = (c.input ?? {}) as Cfg;
      const props_ = Object.entries(cmd?.input.properties ?? {});
      body = (
        <>
          <Select
            label="Command to run"
            value={c.app && c.command ? `${c.app}/${c.command}` : null}
            onChange={(v) => {
              const [app, command] = v.split('/');
              set({ app, command, input: {} });
            }}
            options={meta.commands.map((x) => ({ id: `${x.app}/${x.command}`, label: `${x.app}: ${x.command}` }))}
          />
          {cmd && <p className="text-sm text-muted">{cmd.description} Needs {cmd.permission}.</p>}
          {props_.map(([k, s]) => (
            <TextField
              key={k}
              label={`${k}${cmd?.input.required?.includes(k) ? ' (required)' : ''}`}
              value={show(input[k])}
              description={s.type === 'object' || s.type === 'array' ? `JSON ${s.type}, or a template. ${TEMPLATE_HINT}` : TEMPLATE_HINT}
              onChange={(v) => set({ input: v === '' ? Object.fromEntries(Object.entries(input).filter(([x]) => x !== k)) : { ...input, [k]: coerce(v, s.type) } })}
            />
          ))}
        </>
      );
      break;
    }
    case 'record': {
      const ent = meta.entities.find((e) => e.key === c.entity);
      const values = (c.values ?? {}) as Cfg;
      body = (
        <>
          <Select label="Custom entity" value={c.entity ?? null} onChange={(v) => set({ entity: v, values: {} })} options={meta.entities.map((e) => ({ id: e.key, label: e.label }))} />
          <Select label="Operation" value={c.op ?? 'create'} onChange={(v) => set({ op: v })} options={[{ id: 'create', label: 'Create a record' }, { id: 'update', label: 'Update a record' }]} />
          {c.op === 'update' && field('Record id', 'id', { description: TEMPLATE_HINT })}
          {ent?.fields.map((f) => (
            <TextField key={f.key} label={f.label} value={show(values[f.key])} description={TEMPLATE_HINT} onChange={(v) => set({ values: v === '' ? Object.fromEntries(Object.entries(values).filter(([x]) => x !== f.key)) : { ...values, [f.key]: coerce(v, f.type === 'number' || f.type === 'money' ? 'number' : f.type === 'boolean' ? 'boolean' : 'string') } })} />
          ))}
        </>
      );
      break;
    }
    case 'hub_send':
      body = (
        <>
          <Select label="Hub endpoint" value={c.endpoint_id ?? null} onChange={(v) => set({ endpoint_id: v })} options={meta.endpoints.map((e) => ({ id: e.id, label: `${e.name} (${e.kind})` }))} />
          <JsonField label="Body (JSON with templates)" value={c.body ?? {}} onChange={(v) => set({ body: v })} description={TEMPLATE_HINT} />
        </>
      );
      break;
    case 'notify':
      body = (
        <>
          <RolePicker label="Notify everyone with these roles" roles={meta.roles} value={c.roles ?? []} onChange={(v) => set({ roles: v })} />
          {field('Subject', 'subject')}
          <TextArea label="Message" value={c.message ?? ''} onChange={(v) => set({ message: v })} description={TEMPLATE_HINT} />
        </>
      );
      break;
    case 'wait':
      body = (
        <>
          <Select label="Wait for" value={c.mode ?? 'duration'} onChange={(v) => props.onChange({ ...node, config: v === 'duration' ? { mode: 'duration', seconds: 60 } : { mode: 'event', event: meta.events[0]?.type ?? '', timeout_seconds: 3600 } })} options={[{ id: 'duration', label: 'A duration' }, { id: 'event', label: 'An event (with a timeout)' }]} />
          {c.mode === 'event' ? (
            <>
              <Select label="Event" value={c.event ?? null} onChange={(v) => set({ event: v })} options={meta.events.map((e) => ({ id: e.type, label: e.type }))} />
              {field('Match (filter)', 'filter', { description: 'E.g. event.data.order_id == trigger.data.order_id' })}
              {field('Time out after (seconds)', 'timeout_seconds', { type: 'integer' })}
            </>
          ) : (
            field('Seconds', 'seconds', { type: 'integer' })
          )}
        </>
      );
      break;
    case 'approval':
      body = (
        <>
          {field('Title', 'title', { description: TEMPLATE_HINT })}
          <TextArea label="Details shown to approvers" value={c.details ?? ''} onChange={(v) => set({ details: v })} />
          <RolePicker label="Approvers" roles={meta.roles} value={c.approver_roles ?? []} onChange={(v) => set({ approver_roles: v })} />
          {field('Approvals needed (quorum)', 'quorum', { type: 'integer' })}
          {field('Expires after (hours)', 'expires_in_hours', { type: 'integer' })}
        </>
      );
      break;
    case 'set': {
      const vars = Object.entries((c.vars ?? {}) as Cfg);
      body = (
        <>
          {vars.map(([k, v], i) => (
            <div key={i} className="grid grid-cols-[1fr_2fr_auto] items-end gap-2">
              <TextField label={`Variable ${i + 1} name`} value={k} onChange={(nk) => set({ vars: Object.fromEntries(vars.map(([x, y], j) => (j === i ? [nk, y] : [x, y]))) })} />
              <TextField label={`Variable ${i + 1} value`} value={show(v)} onChange={(nv) => set({ vars: Object.fromEntries(vars.map(([x, y], j) => (j === i ? [x, coerce(nv, 'number')] : [x, y]))) })} />
              <Button variant="secondary" aria-label={`Remove variable ${i + 1}`} onPress={() => set({ vars: Object.fromEntries(vars.filter((_, j) => j !== i)) })}>
                Remove
              </Button>
            </div>
          ))}
          <Button variant="secondary" onPress={() => set({ vars: { ...(c.vars ?? {}), [`var_${vars.length + 1}`]: '' } })}>
            Add variable
          </Button>
        </>
      );
      break;
    }
    case 'code':
      body = (
        <>
          <TextArea label="Code" mono rows={10} value={c.source ?? ''} onChange={(v) => set({ source: v })} description="Define function transform(input) { … } — input has trigger, steps and vars. Runs in an isolated sandbox." />
          {field('Time limit (ms)', 'timeout_ms', { type: 'integer' })}
          {field('Memory limit (MB)', 'memory_mb', { type: 'integer' })}
        </>
      );
      break;
    case 'merge':
      body = <Select label="Joins the branches of" value={c.parallel ?? null} onChange={(v) => set({ parallel: v })} options={props.graph.nodes.filter((n) => n.type === 'parallel').map((n) => ({ id: n.id, label: n.name }))} />;
      break;
    case 'parallel':
      body = <p className="text-sm text-muted">Connect its output to two or more nodes; they run side by side. Add a Merge node to wait for all of them.</p>;
      break;
  }
  return (
    <fieldset disabled={props.readOnly} className="flex flex-col gap-3">
      <legend className="sr-only">Configure {node.name}</legend>
      <p className="text-sm text-muted">
        {NODE_LABELS[node.type]} · id <code>{node.id}</code> · outputs {outputPorts(node).join(', ')}
      </p>
      <TextField label="Name" value={node.name} onChange={(v) => props.onChange({ ...node, name: v })} />
      {body}
    </fieldset>
  );
}

/** Default config for a new node of a type. */
export function defaultConfig(type: string, meta: WorkflowMeta, graph: WorkflowGraph): Cfg {
  switch (type) {
    case 'condition':
      return { expr: 'true' };
    case 'switch':
      return { cases: [{ port: 'case_1', expr: 'true' }] };
    case 'command':
      return meta.commands[0] ? { app: meta.commands[0].app, command: meta.commands[0].command, input: {} } : {};
    case 'record':
      return { entity: meta.entities[0]?.key ?? '', op: 'create', values: {} };
    case 'hub_send':
      return { endpoint_id: meta.endpoints[0]?.id ?? '', body: {} };
    case 'notify':
      return { roles: ['Manager'], users: [], subject: 'Workflow notice', message: 'Something happened.' };
    case 'wait':
      return { mode: 'duration', seconds: 60 };
    case 'approval':
      return { title: 'Please approve', details: '', approver_roles: ['Manager'], quorum: 1, expires_in_hours: 72 };
    case 'set':
      return { vars: { note: '' } };
    case 'code':
      return { source: 'function transform(input) {\n  return { ok: true };\n}', timeout_ms: 250, memory_mb: 16 };
    case 'merge':
      return { parallel: graph.nodes.find((n) => n.type === 'parallel')?.id ?? '' };
    default:
      return {};
  }
}
