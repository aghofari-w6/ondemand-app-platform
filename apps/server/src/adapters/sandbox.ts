import ivm from 'isolated-vm';
import type { Sandbox } from '../ports/index.ts';

/**
 * Sandbox port on isolated-vm: a fresh V8 isolate per run with a memory cap and a
 * wall-clock timeout. Code sees only its JSON input; there is no require, process,
 * network or file system. Input and output cross the boundary as JSON strings.
 */
export function createSandbox(): Sandbox {
  return {
    async run(code, input, limits) {
      const isolate = new ivm.Isolate({ memoryLimit: Math.max(8, limits.memoryMb) });
      try {
        const context = await isolate.createContext();
        await context.global.set('__input', JSON.stringify(input ?? null));
        const script = await isolate.compileScript(
          `${code}\n;(function(){ if (typeof transform !== 'function') throw new Error('define function transform(input, ctx)'); const r = transform(JSON.parse(__input), Object.freeze({})); return JSON.stringify(r === undefined ? null : r); })()`,
        );
        const out = await script.run(context, { timeout: limits.timeoutMs });
        if (typeof out !== 'string') throw new Error('transform must return JSON-serialisable data');
        if (out.length > 1_000_000) throw new Error('transform output is larger than 1 MB');
        return JSON.parse(out);
      } finally {
        if (!isolate.isDisposed) isolate.dispose();
      }
    },
  };
}
