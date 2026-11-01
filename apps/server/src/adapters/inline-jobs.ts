import { randomUUID } from 'node:crypto';
import type { Jobs } from '../ports/index.ts';

/**
 * In-process Jobs adapter for the seed script and tests: `runAll()` processes queued
 * jobs in order, retrying a failing job up to twice like the pg-boss queues.
 */
export class InlineJobs implements Jobs {
  queue: { queue: string; data: any; retry: number }[] = [];
  handlers = new Map<string, (d: any, j: { id: string; retryCount: number }) => Promise<void>>();
  async send(queue: string, data: object) {
    this.queue.push({ queue, data, retry: 0 });
    return randomUUID();
  }
  async work(queue: string, h: any) {
    this.handlers.set(queue, h);
  }
  async schedule() {}
  async start() {}
  async stop() {}
  async runAll() {
    while (this.queue.length) {
      const j = this.queue.shift()!;
      const h = this.handlers.get(j.queue);
      if (!h) throw new Error(`no handler for queue ${j.queue}`);
      try {
        await h(j.data, { id: randomUUID(), retryCount: j.retry });
      } catch (e) {
        if (j.retry >= 2) throw e;
        this.queue.push({ ...j, retry: j.retry + 1 });
      }
    }
  }
}
