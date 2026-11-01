import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_URL: z.string().default('http://localhost:3000'),
  /** app role (aod_app): no BYPASSRLS, no DDL */
  DATABASE_URL: z.string().default('postgres://aod_app:aod_app_dev@localhost:5432/aod'),
  /** owner role, used only by migrations and the seed bootstrap */
  MIGRATION_DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/aod'),
  /** demo mode shows magic links and invite links on screen instead of sending them */
  DEMO_MODE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** base64 32-byte key for AES-256-GCM (Vault port) */
  VAULT_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default('claude-opus-5-5'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  /** run the outbox dispatcher and job workers in this process */
  WORKERS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  LOG_LEVEL: z.string().default('info'),
  /** poll interval for the outbox dispatcher, ms */
  DISPATCH_INTERVAL_MS: z.coerce.number().default(200),
});
export type Env = z.infer<typeof Env>;

const Plan = z.object({ label: z.string(), packages: z.array(z.string()), app_slots: z.int().positive() });
const PlatformConfig = z.object({
  trial: z.object({ days: z.int().positive(), purge_after_days: z.int().positive() }),
  deprovision: z.object({ retain_days: z.int().positive() }),
  plans: z.record(z.string(), Plan),
  channels: z.record(z.string(), z.object({ stable: z.string(), canary: z.string().optional() })),
  capabilities: z.array(z.object({ id: z.string(), label: z.string(), when_installed: z.array(z.string()).min(1) })),
});
export type PlatformConfig = z.infer<typeof PlatformConfig>;

export function loadEnv(overrides: Record<string, string | undefined> = {}): Env {
  return Env.parse({ ...process.env, ...overrides });
}

export function loadPlatformConfig(path = `${ROOT}config/platform.yaml`): PlatformConfig {
  return PlatformConfig.parse(parse(readFileSync(path, 'utf8')));
}
