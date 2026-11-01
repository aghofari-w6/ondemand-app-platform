import type { Env, PlatformConfig } from '../config.ts';
import type { Database } from '../db/database.ts';
import type { Auth, Billing, Channel, EventBus, Files, Jobs, Llm, Metrics, Retriever, Sandbox, Search, Telemetry, Vault, Webhooks } from '../ports/index.ts';
import type { Catalog } from './catalog.ts';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Everything a request handler, job or consumer needs. Built once in main/test setup. */
export interface Platform {
  env: Env;
  config: PlatformConfig;
  catalog: Catalog;
  database: Database;
  log: Logger;
  ports: {
    eventBus: EventBus;
    search: Search;
    metrics: Metrics;
    jobs: Jobs;
    webhooks: Webhooks;
    channel: Channel;
    auth: Auth;
    vault: Vault;
    files: Files;
    telemetry: Telemetry;
    llm: Llm;
    retriever: Retriever;
    sandbox: Sandbox;
    billing: Billing;
  };
}
