import { BOT_CHANNELS, botOutputPorts, type BotChannel, type BotNode } from '@aod/shared';
import type { ReactNode } from 'react';
import { Button, Checkbox, Select, TextArea, TextField } from './ui';
import { NODE_LABELS } from './workflow-canvas';

/** What the Bot Studio editor knows about the workspace (GET /api/bots/meta). */
export interface BotMeta {
  channels: string[];
  tools: { name: string; label: string; app?: string }[];
  roles: { id: string; name: string }[];
}

type Cfg = Record<string, any>;

export const CHANNEL_LABELS: Record<BotChannel, string> = { widget: 'Web chat widget', telegram: 'Telegram', gmail: 'Gmail' };

/** Optional settings are left out of the config when empty (the validator rejects empty strings). */
const optional = (c: Cfg, key: string, value: string): Cfg => {
  const { [key]: _drop, ...rest } = c;
  return value.trim() ? { ...rest, [key]: value } : rest;
};

const SCOPE_HINT = 'Uses message.text, contact.name, vars.<name> and steps.<node>.output.';

export function BotNodeConfigForm(props: { node: BotNode; meta: BotMeta; onChange: (n: BotNode) => void; readOnly?: boolean }) {
  const { node, meta } = props;
  const c = node.config as Cfg;
  const replace = (config: Cfg) => props.onChange({ ...node, config });
  const set = (patch: Cfg) => replace({ ...c, ...patch });
  let body: ReactNode = null;
  switch (node.type) {
    case 'start': {
      const channels = (c.channels ?? []) as BotChannel[];
      body = (
        <>
          <fieldset>
            <legend className="text-sm font-medium text-ink">Answer on these channels</legend>
            <div className="flex flex-col">
              {BOT_CHANNELS.map((ch) => (
                <Checkbox key={ch} isSelected={channels.includes(ch)} onChange={(on) => set({ channels: on ? [...channels, ch] : channels.filter((x) => x !== ch) })}>
                  {CHANNEL_LABELS[ch]}
                </Checkbox>
              ))}
            </div>
          </fieldset>
          <TextField label="Only if (filter)" value={c.filter ?? ''} description="An expression, e.g. contains(lower(message.text), 'order'). Leave empty for every message." onChange={(v) => replace(optional(c, 'filter', v))} />
        </>
      );
      break;
    }
    case 'message':
      body = <TextArea label="Text" value={c.text ?? ''} onChange={(v) => set({ text: v })} description={`What the bot says. {{ }} inserts a value. ${SCOPE_HINT}`} />;
      break;
    case 'ask':
      body = (
        <>
          <TextArea label="Question" value={c.question ?? ''} onChange={(v) => set({ question: v })} rows={3} />
          <TextField label="Save the answer as" value={c.variable ?? ''} onChange={(v) => set({ variable: v })} description="A variable name in lower_snake_case; later steps read it as vars.<name>." />
          <TextField label="Validation expression" value={c.validate ?? ''} onChange={(v) => replace(optional(c, 'validate', v))} description="Optional. The reply is “answer”, e.g. digits(answer) != null. Leave empty to accept any answer." />
          <TextField label="Retry message" value={c.retry_message ?? ''} onChange={(v) => replace(optional(c, 'retry_message', v))} description="Optional. Said when the answer is not valid; the question is repeated otherwise." />
          <TextField label="Attempts" inputMode="numeric" value={String(c.max_attempts ?? 2)} onChange={(v) => set({ max_attempts: Math.min(5, Math.max(1, Math.round(Number(v)) || 1)) })} description="1 to 5. After the last invalid answer the flow leaves through “invalid”." />
        </>
      );
      break;
    case 'lookup': {
      const input = (c.input ?? {}) as Cfg;
      const known = meta.tools.some((t) => t.name === c.tool);
      body = (
        <>
          <Select
            label="Lookup"
            value={c.tool ?? null}
            onChange={(v) => set({ tool: v })}
            options={[...(c.tool && !known ? [{ id: String(c.tool), label: `${String(c.tool)} (not available to you)` }] : []), ...meta.tools.map((t) => ({ id: t.name, label: `${t.app ?? 'platform'}: ${t.label}` }))]}
          />
          {meta.tools.length === 0 && <p className="text-sm text-muted">No lookups are available: provision an app with read tools (for example Ordering) first.</p>}
          <TextField label="Search for" value={typeof input.q === 'string' ? input.q : input.q === undefined ? '' : String(input.q)} onChange={(v) => set({ input: optional(input, 'q', v) })} description="Text or a {{ }} value, e.g. {{ digits(message.text) }}. Results are in steps.<this node>.output (rows, count, first)." />
          <p className="text-sm text-muted">Personal data is never returned to a bot. The lookup runs with the role chosen at publish.</p>
        </>
      );
      break;
    }
    case 'ask_assistant':
      body = (
        <>
          <TextArea label="Question" value={c.question ?? ''} onChange={(v) => set({ question: v })} rows={3} description="Usually {{ message.text }}. The assistant answers only from public documents and help articles, and cites them." />
          <p className="text-sm text-muted">It has no tools and cannot change anything. When it is not sure, the flow leaves through “unsure”.</p>
        </>
      );
      break;
    case 'handoff':
      body = (
        <>
          <TextArea label="Message" value={c.message ?? ''} onChange={(v) => replace(optional(c, 'message', v))} rows={3} description="Optional. Said to the customer before the conversation moves to the Inbox." />
          <p className="text-sm text-muted">The conversation opens in the Inbox and the bot stops answering it.</p>
        </>
      );
      break;
    case 'condition':
      body = <TextField label="Expression" value={c.expr ?? ''} onChange={(v) => set({ expr: v })} description={`True or false. ${SCOPE_HINT}`} />;
      break;
    case 'switch': {
      const cases = (c.cases ?? []) as { port: string; expr: string }[];
      const update = (i: number, patch: Partial<{ port: string; expr: string }>) => set({ cases: cases.map((k, j) => (j === i ? { ...k, ...patch } : k)) });
      body = (
        <>
          <p className="text-sm text-muted">The first case whose expression is true decides the output; otherwise “default”.</p>
          <ol className="flex flex-col gap-3">
            {cases.map((k, i) => (
              <li key={i} className="flex flex-col gap-2 rounded-lg border border-line p-3">
                <TextField label={`Case ${i + 1} name`} value={k.port} onChange={(v) => update(i, { port: v })} description="lower_snake_case; it becomes the output name." />
                <TextField label={`Case ${i + 1} expression`} value={k.expr} onChange={(v) => update(i, { expr: v })} />
                {cases.length > 1 && (
                  <Button variant="secondary" aria-label={`Remove case ${i + 1}`} onPress={() => set({ cases: cases.filter((_k, j) => j !== i) })}>
                    Remove case
                  </Button>
                )}
              </li>
            ))}
          </ol>
          <Button
            variant="secondary"
            onPress={() => {
              let n = cases.length + 1;
              while (cases.some((k) => k.port === `case_${n}`)) n++;
              set({ cases: [...cases, { port: `case_${n}`, expr: 'true' }] });
            }}
          >
            Add case
          </Button>
        </>
      );
      break;
    }
  }
  const ports = botOutputPorts(node);
  return (
    <fieldset disabled={props.readOnly} className="flex flex-col gap-3">
      <legend className="sr-only">Configure {node.name}</legend>
      <p className="text-sm text-muted">
        {NODE_LABELS[node.type]} · id <code>{node.id}</code> · {ports.length ? `outputs ${ports.join(', ')}` : 'ends the flow'}
      </p>
      <TextField label="Name" value={node.name} onChange={(v) => props.onChange({ ...node, name: v })} />
      {body}
    </fieldset>
  );
}

/** Default config for a new node of a type. `id` is the new node's id (a unique variable name for questions). */
export function defaultBotConfig(type: string, meta: BotMeta, id: string): Cfg {
  switch (type) {
    case 'message':
      return { text: 'Thanks for your message.' };
    case 'ask':
      return { question: 'What is your order number?', variable: id, max_attempts: 2 };
    case 'lookup':
      return { tool: meta.tools[0]?.name ?? '', input: { q: '{{ digits(message.text) }}' } };
    case 'ask_assistant':
      return { question: '{{ message.text }}' };
    case 'handoff':
      return { message: 'I am handing you to a colleague who can help.' };
    case 'condition':
      return { expr: 'true' };
    case 'switch':
      return { cases: [{ port: 'case_1', expr: 'true' }] };
    default:
      return {};
  }
}
