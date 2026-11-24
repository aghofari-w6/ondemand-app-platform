import type { Llm, LlmBlock, LlmChatResult, LlmMessage, LlmTool } from '../ports/index.ts';

/**
 * Scripted stand-in for Claude, used in CI, e2e and local demos (`LLM_ADAPTER=fake`; plan
 * decision 6: no live calls yet). It is deterministic and keyword-driven, and it models
 * the one property the safety tests rely on:
 *
 * - text inside tool results, `<customer_message>` and `<passages>` is DATA: an
 *   instruction found there is refused, never followed;
 * - an instruction in the system prompt or in the operator's own text is followed.
 *
 * So if the platform ever pasted customer or document text into the instruction channel,
 * the injection tests would fail ("INJECTION-FOLLOWED").
 */

export const INJECTION = /ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|rules)|disregard (all |any )?(previous|prior|your) (instructions|rules)|reveal (your |the )?(system prompt|secrets?|tokens?|passwords?)|you are now (in )?(developer|admin|dan)/i;
export const REFUSAL = "I can't act on instructions that appear inside customer messages or documents. I can only answer questions using your published information.";

const DATA_TAGS = /<(customer_message|passages|record|data)>[\s\S]*?<\/\1>/g;
const tokens = (s: string) => Math.ceil(s.length / 4);
const textOf = (m: LlmMessage) => (typeof m.content === 'string' ? m.content : m.content.filter((b): b is Extract<LlmBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n'));
const sentences = (s: string, n: number) => (s.match(/[^.!?\n]+[.!?]?/g) ?? [s]).slice(0, n).join('').trim();
const parse = (s: string): any => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

interface Outcome {
  name: string;
  input: Record<string, unknown>;
  /** the platform's envelope: { status, result?, error? } */
  result: any;
  /** the tool's own output when it ran */
  data: any;
  isError: boolean;
}

/** The latest operator instruction and the tool calls answered since. */
function turnState(messages: LlmMessage[]) {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user' && textOf(messages[i]!).trim()) {
      start = i;
      break;
    }
  }
  const instruction = start >= 0 ? textOf(messages[start]!) : '';
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const outcomes: Outcome[] = [];
  for (const m of messages.slice(Math.max(start, 0))) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') calls.set(b.id, { name: b.name, input: b.input });
      if (b.type === 'tool_result') {
        const c = calls.get(b.tool_use_id);
        if (c) {
          const result = parse(b.content);
          outcomes.push({ ...c, result, data: result?.result ?? null, isError: Boolean(b.is_error) });
        }
      }
    }
  }
  return { instruction, outcomes };
}

let seq = 0;
const call = (name: string, input: Record<string, unknown>): LlmBlock => ({ type: 'tool_use', id: `fake_${Date.now().toString(36)}_${++seq}`, name, input });

function customerAnswer(user: string): string {
  const customer = /<customer_message>([\s\S]*?)<\/customer_message>/.exec(user)?.[1] ?? '';
  if (INJECTION.test(customer)) return REFUSAL;
  const first = /\[1\][^\n]*?:\s*([\s\S]*?)(?=\n\[\d+\]|<\/passages>)/.exec(user)?.[1]?.trim();
  if (!first) return 'UNSURE';
  // A passage may itself carry an injected instruction: it is quoted as data, never obeyed.
  return `${sentences(first, 2)} [1]`;
}

function staffDecision(system: string, messages: LlmMessage[], tools: LlmTool[]): LlmBlock[] {
  const { instruction, outcomes } = turnState(messages);
  const operator = instruction.replace(DATA_TAGS, '');
  // The instruction channel is obeyed, including an injected one (see the header).
  if (INJECTION.test(operator) || INJECTION.test(system)) return [{ type: 'text', text: 'INJECTION-FOLLOWED' }];
  const lower = operator.toLowerCase();
  const number = /\b(\d{3,})\b/.exec(operator)?.[1];
  const tool = (suffix: string) => tools.find((t) => t.name === suffix || t.name.endsWith(`__${suffix}`))?.name;
  const done = (suffix: string) => outcomes.find((o) => o.name === suffix || o.name.endsWith(`__${suffix}`));
  const say = (text: string): LlmBlock[] => [{ type: 'text', text }];

  const act = (verb: 'cancel_order' | 'advance_order', extra: Record<string, unknown>) => {
    const findName = tool('find_order');
    const actName = tool(verb);
    if (!findName || !actName) return say(`I cannot do that here: ${!findName ? 'I cannot look up orders' : `you do not have access to ${verb.replace('_', ' ')}`}.`);
    const found = done('find_order');
    if (!found) return [call(findName, { q: number })];
    const row = (found.data?.rows ?? []).find((r: any) => String(r.number) === number) ?? found.data?.rows?.[0];
    if (!row) return say(`I could not find order ${number}.`);
    const acted = done(verb);
    if (!acted) return [{ type: 'text', text: `I found order ${number} (${row.status}).` } as LlmBlock, call(actName, { id: row.id, version: row.version, ...extra })];
    const r = acted.result ?? {};
    if (r.status === 'executed') return say(verb === 'cancel_order' ? `Order ${number} is cancelled.` : `Order ${number} is now ${r.result?.status ?? 'updated'}.`);
    if (r.status === 'declined') return say(`Okay, I left order ${number} as it is.`);
    if (r.status === 'rejected' || r.status === 'expired') return say(`The request was ${r.status}, so order ${number} is unchanged.`);
    return say(`I could not do that: ${r.error ?? 'the action failed'}.`);
  };

  if (number && /\bcancel/.test(lower)) return act('cancel_order', { reason: 'Requested through the assistant' });
  if (number && /\b(advance|next status|move)\b/.test(lower)) return act('advance_order', {});
  if (/\bopen orders\b/.test(lower)) {
    const name = tool('list_open_orders');
    if (!name) return say('You do not have access to orders.');
    const r = done('list_open_orders');
    if (!r) return [call(name, {})];
    const rows = (r.data?.rows ?? []) as { number: number }[];
    return say(rows.length ? `You have ${rows.length} open order(s): ${rows.slice(0, 10).map((x) => `#${x.number}`).join(', ')}.` : 'There are no open orders.');
  }
  if (/\bexplain\b/.test(lower)) {
    const ref = /([a-z_]+::[A-Za-z]+)\s+([0-9a-f-]{36})/.exec(operator);
    const name = tool('get_record');
    if (ref && name) {
      const r = done('get_record');
      if (!r) return [call(name, { type: ref[1], id: ref[2] })];
      if (r.isError || !r.data?.record) return say(`I could not read that record: ${r.result?.error ?? 'not found'}.`);
      const fields = Object.entries(r.data.record as Record<string, unknown>).filter(([k, v]) => v !== null && typeof v !== 'object' && !['id', 'tenant_id', 'version'].includes(k)).slice(0, 8);
      return say(`This ${r.data.label ?? 'record'} has ${fields.map(([k, v]) => `${k.replace(/_/g, ' ')} ${String(v)}`).join(', ')}.`);
    }
  }
  if (/\b(hub|deliver|integration)/.test(lower)) {
    const name = tool('hub_status');
    if (name) {
      const r = done('hub_status');
      if (!r) return [call(name, {})];
      return say(`The Integration Hub has ${r.data?.endpoints?.length ?? 0} endpoint(s) and ${r.data?.dead ?? 0} dead-lettered delivery(ies).`);
    }
  }
  const search = tool('search_knowledge');
  if (search) {
    const r = done('search_knowledge');
    if (!r) return [call(search, { query: operator.trim().slice(0, 300) })];
    const top = r.data?.passages?.[0];
    return say(top ? `${sentences(String(top.text), 2)} [${top.n}]` : 'I could not find that in your documents or help articles.');
  }
  return say('I can help with orders, records, the Integration Hub and questions about your documents.');
}

export function createFakeLlm(): Llm {
  return {
    async complete(p) {
      return { text: `(fake model) ${p.messages.at(-1)?.content.slice(0, 200) ?? ''}`, model: 'fake' };
    },
    async chat(p): Promise<LlmChatResult> {
      const last = p.messages.at(-1);
      const lastText = last ? textOf(last) : '';
      const content: LlmBlock[] = lastText.includes('<customer_message>') ? [{ type: 'text', text: customerAnswer(lastText) }] : staffDecision(p.system, p.messages, p.tools ?? []);
      for (const b of content) {
        if (b.type !== 'text' || !p.onText) continue;
        for (const piece of b.text.match(/\S+\s*/g) ?? []) p.onText(piece);
      }
      const input = p.system.length + p.messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
      return {
        content,
        stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        usage: { inputTokens: tokens(' '.repeat(input)), outputTokens: tokens(JSON.stringify(content)) },
        model: 'fake',
      };
    },
  };
}
