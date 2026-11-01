import type { Env, PlatformConfig } from '../config.ts';
import type { Database } from '../db/database.ts';
import type { Analytics, Auth, Billing, Channel, EventBus, Files, Jobs, Llm, Metrics, Retriever, Sandbox, Search, Telemetry, Vault, Webhooks } from '../ports/index.ts';
import type { Catalog } from './catalog.ts';
import type { HubDeliverer } from './hub.ts';
import type { IndexBuilder } from './maintenance.ts';
import type { WorkflowRunner } from './workflows/engine.ts';

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
  /** in-process background workers (started by startWorkers) */
  workers: { hub: HubDeliverer; workflows: WorkflowRunner; indexes: IndexBuilder | null };
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
    analytics: Analytics;
  };
}
