import { NodeSDK } from '@opentelemetry/sdk-node';
import { buildApp } from './http/app.ts';
import { createPlatform, startWorkers, stopPlatform } from './platform/create.ts';

// OpenTelemetry: exporters are configured through the standard OTEL_* env vars.
const otel = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? new NodeSDK({ serviceName: 'apps-on-demand' }) : null;
otel?.start();

const p = createPlatform();
const app = await buildApp(p);
if (p.env.WORKERS) await startWorkers(p);
await app.listen({ port: p.env.PORT, host: p.env.HOST });
p.log.info({ port: p.env.PORT, workers: p.env.WORKERS }, 'apps-on-demand listening');

// One handled promise, one exit: a failing close must not become an unhandled rejection.
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  try {
    await app.close();
    await stopPlatform(p);
    await otel?.shutdown();
    p.log.info({ signal }, 'apps-on-demand stopped');
    process.exit(0);
  } catch (e) {
    p.log.error({ err: String(e), signal }, 'shutdown failed');
    process.exit(1);
  }
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    shutdown(signal).catch(() => process.exit(1));
  });
}
