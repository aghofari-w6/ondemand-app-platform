import { CommandError } from '@aod/shared';
import { sql } from 'kysely';
import type { Tx } from '../../db/database.ts';
import type { Platform } from '../context.ts';
import { planLimit } from '../packages.ts';

/** First day of the current month (UTC): the usage period. */
export const usageMonth = (now = new Date()) => `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;

export interface Usage {
  tokensIn?: number;
  tokensOut?: number;
  embedTokens?: number;
  requests?: number;
}

/** Adds to the tenant's monthly counters (model tokens and embedding tokens). */
export async function addUsage(tx: Tx, tenantId: string, u: Usage) {
  const v = { in: u.tokensIn ?? 0, out: u.tokensOut ?? 0, embed: u.embedTokens ?? 0, requests: u.requests ?? 0 };
  if (!v.in && !v.out && !v.embed && !v.requests) return;
  await sql`
    INSERT INTO assistant_usage (tenant_id, month, tokens_in, tokens_out, embed_tokens, requests)
    VALUES (${tenantId}, ${usageMonth()}::date, ${v.in}, ${v.out}, ${v.embed}, ${v.requests})
    ON CONFLICT (tenant_id, month) DO UPDATE SET
      tokens_in = assistant_usage.tokens_in + EXCLUDED.tokens_in,
      tokens_out = assistant_usage.tokens_out + EXCLUDED.tokens_out,
      embed_tokens = assistant_usage.embed_tokens + EXCLUDED.embed_tokens,
      requests = assistant_usage.requests + EXCLUDED.requests`.execute(tx);
}

export async function usageSummary(p: Platform, tx: Tx) {
  const limit = await planLimit(p, tx, 'assistant_tokens_month');
  const row = (await sql<{ tokens_in: number; tokens_out: number; embed_tokens: number; requests: number }>`SELECT tokens_in, tokens_out, embed_tokens, requests FROM assistant_usage WHERE month = ${usageMonth()}::date`.execute(tx)).rows[0];
  const used = (row?.tokens_in ?? 0) + (row?.tokens_out ?? 0);
  return { month: usageMonth(), limit, used, tokens_in: row?.tokens_in ?? 0, tokens_out: row?.tokens_out ?? 0, embed_tokens: row?.embed_tokens ?? 0, requests: row?.requests ?? 0, remaining: Math.max(0, limit - used) };
}

/** Refuses a model call once the tenant's monthly token limit is used up. */
export async function assertBudget(p: Platform, tx: Tx) {
  const u = await usageSummary(p, tx);
  if (u.used >= u.limit) throw new CommandError(429, 'assistant_limit', `this workspace has used its ${u.limit.toLocaleString('en')} assistant tokens for the month`);
  return u;
}

/** Like assertBudget, for background callers (bots) that must not throw. */
export async function hasBudget(p: Platform, tx: Tx): Promise<boolean> {
  const u = await usageSummary(p, tx);
  return u.used < u.limit;
}
