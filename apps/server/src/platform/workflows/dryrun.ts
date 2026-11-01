import { CommandError, evalCondition, renderTemplate, type EventEnvelope, type Template, type WorkflowGraph, type WorkflowNode } from '@aod/shared';
import type { Platform } from '../context.ts';
import { computePure } from './engine.ts';

/**
 * Test run: executes a graph against a sample or past event without changing anything.
 * Pure nodes and code nodes run for real; side-effecting nodes (command, record,
 * hub_send, notify) render their input and stop there (commands also validate it
 * against the command's schema). Waits and approvals take the outcome the caller
 * assumes.
 */

export interface DryRunStep {
  node: string;
  type: string;
  status: 'succeeded' | 'failed';
  input: unknown;
  output: unknown;
  port: string | null;
  error: string | null;
  ms: number;
}

export interface DryRunOptions {
  approval?: 'approved' | 'rejected' | 'expired';
  wait?: 'event' | 'timeout';
}

const MAX_STEPS = 500;

export async function dryRun(p: Platform, graph: WorkflowGraph, event: EventEnvelope, opts: DryRunOptions = {}): Promise<{ matched: boolean; steps: DryRunStep[]; path: string[]; error: string | null }> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const trigger = graph.nodes.find((n) => n.type === 'trigger');
  if (!trigger) return { matched: false, steps: [], path: [], error: 'the workflow has no trigger' };
  const filter = (trigger.config as { filter?: string }).filter;
  if (filter) {
    try {
      if (!evalCondition(filter, { trigger: event })) return { matched: false, steps: [], path: [], error: null };
    } catch (e) {
      return { matched: false, steps: [], path: [], error: `trigger filter: ${(e as Error).message}` };
    }
  }
  const steps: DryRunStep[] = [];
  const scope: Record<string, any> = { trigger: event, steps: {}, vars: {}, run: { id: 'test-run', workflow_id: 'test', hop: event.workflow_hop + 1, correlation_id: event.correlation_id } };
  let failed: string | null = null;

  const exec = async (node: WorkflowNode, input: unknown): Promise<{ port: string; output: unknown } | null> => {
    const started = Date.now();
    const c = node.config as Record<string, any>;
    const rendered = (t: unknown) => renderTemplate(t as Template, scope);
    try {
      let r: { port: string; output: unknown };
      let shownInput: unknown = input;
      switch (node.type) {
        case 'code': {
          const sandboxIn = { trigger: scope.trigger, steps: scope.steps, vars: scope.vars };
          shownInput = sandboxIn;
          r = { port: 'out', output: await p.ports.sandbox.run(c.source, sandboxIn, { timeoutMs: c.timeout_ms ?? 250, memoryMb: c.memory_mb ?? 16 }) };
          break;
        }
        case 'command': {
          const cmdInput = rendered(c.input ?? {});
          shownInput = cmdInput;
          const found = p.catalog.command(c.app, c.command);
          if (!found) throw new CommandError(422, 'unknown_command', `unknown command ${c.app}/${c.command}`);
          const check = found.spec.input.safeParse(cmdInput);
          if (!check.success) throw new CommandError(422, 'invalid_input', check.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
          r = { port: 'out', output: { dry_run: true, would_run: `${c.app}/${c.command}`, input: check.data } };
          break;
        }
        case 'record': {
          const values = rendered(c.values ?? {});
          shownInput = values;
          r = { port: 'out', output: { dry_run: true, would_write: `${c.entity} (${c.op})`, id: c.id ? rendered(c.id) : null, values } };
          break;
        }
        case 'hub_send': {
          const body = rendered(c.body ?? {});
          shownInput = body;
          r = { port: 'out', output: { dry_run: true, would_send_to: c.endpoint_id, body } };
          break;
        }
        case 'notify': {
          const msg = { subject: rendered(c.subject), message: rendered(c.message) };
          shownInput = msg;
          r = { port: 'out', output: { dry_run: true, would_notify: { roles: c.roles ?? [], users: c.users ?? [] }, ...msg } };
          break;
        }
        case 'wait':
          r = c.mode === 'event' ? (opts.wait === 'timeout' ? { port: 'timeout', output: { timed_out: true } } : { port: 'event', output: { assumed: true, type: c.event } }) : { port: 'out', output: { waited_seconds: c.seconds } };
          break;
        case 'approval': {
          const req = { title: rendered(c.title), details: rendered(c.details ?? ''), approver_roles: c.approver_roles, quorum: c.quorum ?? 1 };
          shownInput = req;
          const outcome = opts.approval ?? 'approved';
          r = { port: outcome, output: { assumed: true, status: outcome } };
          break;
        }
        default:
          r = computePure(node, scope, input);
      }
      if (node.type === 'set') scope.vars = { ...scope.vars, ...(r.output as object) };
      scope.steps[node.id] = { output: r.output, port: r.port };
      steps.push({ node: node.id, type: node.type, status: 'succeeded', input: shownInput ?? null, output: r.output, port: r.port, error: null, ms: Date.now() - started });
      return r;
    } catch (e) {
      const message = (e as Error).message;
      if (graph.edges.some((x) => x.from === node.id && x.port === 'error') && ['command', 'record', 'hub_send', 'notify', 'code'].includes(node.type)) {
        const output = { error: message, code: e instanceof CommandError ? e.code : 'node_failed' };
        scope.steps[node.id] = { output, port: 'error' };
        steps.push({ node: node.id, type: node.type, status: 'succeeded', input: input ?? null, output, port: 'error', error: message, ms: Date.now() - started });
        return { port: 'error', output };
      }
      steps.push({ node: node.id, type: node.type, status: 'failed', input: input ?? null, output: null, port: null, error: message, ms: Date.now() - started });
      failed = `${node.id}: ${message}`;
      return null;
    }
  };

  /** Walks a single path from `id` until it ends or reaches `stopAt` (a merge). */
  const walk = async (startId: string, input: unknown, stopAt: string | null): Promise<{ arrivedFrom: string | null }> => {
    let id: string | null = startId;
    let prev: string | null = null;
    let carry = input;
    while (id) {
      if (failed || steps.length >= MAX_STEPS) return { arrivedFrom: null };
      if (id === stopAt) return { arrivedFrom: prev };
      const node: WorkflowNode = byId.get(id)!;
      const r = await exec(node, carry);
      if (!r) return { arrivedFrom: null };
      if (node.type === 'parallel') {
        const merge: WorkflowNode | null = graph.nodes.find((n) => n.type === 'merge' && n.config.parallel === node.id) ?? null;
        const branches: Record<string, unknown> = {};
        for (const e of graph.edges.filter((x) => x.from === node.id && x.port === 'out')) {
          const b = await walk(e.to, r.output, merge?.id ?? null);
          if (b.arrivedFrom) branches[b.arrivedFrom] = scope.steps[b.arrivedFrom]?.output ?? null;
        }
        if (!merge || !Object.keys(branches).length || failed) return { arrivedFrom: null };
        prev = node.id;
        id = merge.id;
        carry = { branches };
        continue;
      }
      const next = graph.edges.find((x) => x.from === node.id && x.port === r.port);
      if (!next) return { arrivedFrom: null };
      prev = node.id;
      id = next.to;
      carry = r.output;
    }
    return { arrivedFrom: null };
  };

  await walk(trigger.id, null, null);
  return { matched: true, steps, path: steps.map((s) => s.node), error: failed };
}
