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

const shutdown = async () => {
  await app.close();
  await stopPlatform(p);
  await otel?.shutdown();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
