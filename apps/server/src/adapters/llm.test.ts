import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createLlm } from './index.ts';

describe('Llm adapter', () => {
  it('creates one Claude client per process, not one per call', async () => {
    let made = 0;
    const fake = { messages: { create: async () => ({ content: [{ type: 'text', text: 'ok' }], model: 'test-model' }) } } as unknown as Anthropic;
    const llm = createLlm('test-key', 'test-model', () => {
      made++;
      return fake;
    });
    for (let i = 0; i < 5; i++) expect((await llm.complete({ messages: [{ role: 'user', content: 'hi' }] })).text).toBe('ok');
    expect(made).toBe(1);
  });

  it('fails clearly without a key and creates no client', async () => {
    let made = 0;
    const llm = createLlm(undefined, 'm', () => {
      made++;
      return {} as Anthropic;
    });
    await expect(llm.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(made).toBe(0);
  });
});
