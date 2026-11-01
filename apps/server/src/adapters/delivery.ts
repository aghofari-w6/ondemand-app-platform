import { createHmac } from 'node:crypto';
import net, { isIP } from 'node:net';
import tls from 'node:tls';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Redis } from 'ioredis';
import { Kafka, type SASLOptions } from 'kafkajs';
import SftpClient from 'ssh2-sftp-client';
import { Agent, fetch } from 'undici';
import type { DeliveryResult, OutboundMessage, Webhooks } from '../ports/index.ts';
import { BlockedAddressError, checkHost, isPrivateAddress, safeLookup, type SsrfPolicy } from './ssrf.ts';

/**
 * Outbound delivery adapter (Webhooks port). External systems are reached only as API
 * clients: HTTP (undici), Kafka (kafkajs), Redis Streams (ioredis), SFTP
 * (ssh2-sftp-client) and SQS (AWS SDK). Every connection passes the SSRF policy.
 */

const TIMEOUT_MS = 10_000;
/** Bytes of a remote response kept for the delivery log; the rest is never read. */
export const RESPONSE_EXCERPT_BYTES = 2048;

/**
 * Reads at most `maxBytes` of a response body, then cancels the stream, so a remote
 * endpoint cannot make us hold a large (or endless) body in memory.
 */
export async function readExcerpt(res: Response, maxBytes = RESPONSE_EXCERPT_BYTES, onCleanupError: (what: string, e: unknown) => void = () => undefined): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = value.subarray(0, maxBytes - size);
      chunks.push(take);
      size += take.length;
    }
  } catch {
    // a body that fails mid-way still yields what was read
  } finally {
    // Stop the transfer; the connection is not reused for the rest of the body.
    await reader.cancel().catch((e: unknown) => onCleanupError('cancelling the response body', e));
  }
  return new TextDecoder().decode(Buffer.concat(chunks)).replace(/\uFFFD$/, '');
}

/** Standard Webhooks signature: base64(HMAC-SHA256(secret, `${id}.${timestamp}.${body}`)). */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

export function verifyWebhook(secret: string, headers: Record<string, string | undefined>, body: string, toleranceSec = 300): boolean {
  const id = headers['webhook-id'];
  const ts = Number(headers['webhook-timestamp']);
  const sigs = (headers['webhook-signature'] ?? '').split(' ');
  if (!id || !Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
  const expected = signWebhook(secret, id, ts, body);
  return sigs.includes(expected);
}

export interface ClientFactories {
  kafka: (cfg: { brokers: string[]; ssl: boolean; sasl?: SASLOptions }) => { producer: () => { connect(): Promise<void>; send(r: any): Promise<unknown>; disconnect(): Promise<void> } };
  redis: (url: string, password?: string) => { xadd(...args: (string | number)[]): Promise<unknown>; quit(): Promise<unknown> };
  sftp: () => { connect(o: any): Promise<unknown>; put(b: Buffer, path: string): Promise<unknown>; end(): Promise<unknown> };
  sqs: (region: string, creds?: { accessKeyId: string; secretAccessKey: string }) => { send(cmd: any): Promise<unknown> };
}

/**
 * kafkajs connects to every broker the cluster advertises in its metadata, not only the
 * bootstrap list; this socket factory applies the SSRF policy to each of those connections.
 */
export function policedKafkaSocketFactory(policy: SsrfPolicy) {
  return ({ host, port, ssl, onConnect }: { host: string; port: number; ssl: any; onConnect: () => void }) => {
    const h = host.replace(/^\[|\]$/g, '').toLowerCase();
    if (isIP(h) && isPrivateAddress(h) && !policy.allow.has(h)) {
      const sock = new net.Socket();
      process.nextTick(() => sock.destroy(new BlockedAddressError(host)));
      return sock;
    }
    const lookup = safeLookup(policy) as any;
    return ssl ? tls.connect({ host, port, servername: host, lookup, ...(typeof ssl === 'object' ? ssl : {}) }, onConnect) : net.connect({ host, port, lookup }, onConnect);
  };
}

export function defaultFactories(policy: SsrfPolicy): ClientFactories {
  return {
    kafka: (cfg) =>
      new Kafka({ clientId: 'apps-on-demand', brokers: cfg.brokers, ssl: cfg.ssl, ...(cfg.sasl ? { sasl: cfg.sasl } : {}), connectionTimeout: TIMEOUT_MS, retry: { retries: 0 }, socketFactory: policedKafkaSocketFactory(policy) as any }),
    redis: (url, password) =>
      new Redis(url, { lazyConnect: false, connectTimeout: TIMEOUT_MS, maxRetriesPerRequest: 1, enableOfflineQueue: true, ...(password ? { password } : {}) }) as any,
    sftp: () => new SftpClient('aod-hub'),
    sqs: (region, creds) => new SQSClient({ region, ...(creds ? { credentials: creds } : {}) }),
  };
}

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

export function createDelivery(policy: SsrfPolicy, opts: { production: boolean; factories?: ClientFactories; log?: (msg: string, err: unknown) => void }): Webhooks {
  const f = opts.factories ?? defaultFactories(policy);
  // Cleanup failures never fail the delivery, but they are logged, not swallowed.
  const cleanupFailed = (what: string, e: unknown) => opts.log?.(`hub delivery: ${what} failed`, e);
  const agent = new Agent({ connect: { lookup: safeLookup(policy) as any, timeout: TIMEOUT_MS }, headersTimeout: TIMEOUT_MS, bodyTimeout: TIMEOUT_MS });

  const checkUrl = async (raw: string) => {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && policy.allow.has(u.hostname.toLowerCase()))) {
      throw new Error('endpoint URLs must use https');
    }
    if (u.username || u.password) throw new Error('put credentials in the credentials field, not in the URL');
    await checkHost(u.hostname, policy);
  };

  async function http(url: string, method: string, body: string, headers: Record<string, string>): Promise<Omit<DeliveryResult, 'durationMs'>> {
    await checkUrl(url);
    const res = await fetch(url, { method, body, headers: { 'content-type': 'application/json', 'user-agent': 'apps-on-demand-hub/1', ...headers }, dispatcher: agent, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await readExcerpt(res, RESPONSE_EXCERPT_BYTES, cleanupFailed);
    if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, error: 'redirects are not followed', response: text };
    return { ok: res.status >= 200 && res.status < 300, status: res.status, response: text, ...(res.ok ? {} : { error: `HTTP ${res.status}` }) };
  }

  const authHeaders = (c: Record<string, any> | null): Record<string, string> => {
    if (!c) return {};
    if (c.type === 'bearer') return { authorization: `Bearer ${c.token}` };
    if (c.type === 'basic') return { authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}` };
    if (c.type === 'header') return { [c.header]: c.value };
    if (typeof c.authorization === 'string') return { authorization: c.authorization };
    return {};
  };

  return {
    async checkTarget(t) {
      switch (t.kind) {
        case 'webhook':
        case 'rest_push':
        case 'http':
          return checkUrl(t.config.url);
        case 'kafka':
          for (const b of t.config.brokers as string[]) await checkHost(b.split(':')[0]!, policy);
          return;
        case 'redis_stream': {
          const u = new URL(t.config.url);
          if (u.username || u.password) throw new Error('put the Redis password in the credentials field, not in the URL');
          return void (await checkHost(u.hostname, policy));
        }
        case 'sftp':
          await checkHost(t.config.host, policy);
          if (t.credentials && !t.credentials.password && !t.credentials.private_key) throw new Error('SFTP needs a password or a private key');
          return;
        case 'sqs':
          if (!t.credentials?.access_key_id || !t.credentials?.secret_access_key) throw new Error('SQS endpoints need their own credentials');
          return checkUrl(t.config.queue_url);
      }
    },

    async deliver(t, msg: OutboundMessage) {
      const started = Date.now();
      const done = (r: Omit<DeliveryResult, 'durationMs'>): DeliveryResult => ({ ...r, durationMs: Date.now() - started });
      try {
        switch (t.kind) {
          case 'webhook': {
            const ts = Math.floor(msg.timestamp.getTime() / 1000);
            return done(
              await http(t.config.url, 'POST', msg.body, {
                'webhook-id': msg.id,
                'webhook-timestamp': String(ts),
                ...(t.signingSecret ? { 'webhook-signature': signWebhook(t.signingSecret, msg.id, ts, msg.body) } : {}),
              }),
            );
          }
          case 'rest_push':
          case 'http':
            return done(await http(t.config.url, t.config.method ?? 'POST', msg.body, { 'idempotency-key': msg.id, ...authHeaders(t.credentials) }));
          case 'kafka': {
            for (const b of t.config.brokers as string[]) await checkHost(b.split(':')[0]!, policy);
            const c = t.credentials;
            const producer = f.kafka({ brokers: t.config.brokers, ssl: t.config.ssl !== false, ...(c ? { sasl: { mechanism: c.mechanism, username: c.username, password: c.password } as SASLOptions } : {}) }).producer();
            await producer.connect();
            try {
              await producer.send({ topic: t.config.topic, messages: [{ key: msg.id, value: msg.body, headers: { 'event-id': msg.id, 'event-type': msg.type } }] });
            } finally {
              await producer.disconnect();
            }
            return done({ ok: true });
          }
          case 'redis_stream': {
            await checkHost(new URL(t.config.url).hostname, policy);
            const r = f.redis(t.config.url, t.credentials?.password);
            try {
              const trim = t.config.maxlen ? ['MAXLEN', '~', t.config.maxlen] : [];
              const id = await r.xadd(t.config.stream, ...trim, '*', 'event_id', msg.id, 'type', msg.type, 'body', msg.body);
              return done({ ok: true, response: String(id) });
            } finally {
              await r.quit().catch((e: unknown) => cleanupFailed('closing the Redis connection', e));
            }
          }
          case 'sftp': {
            const [addr] = await checkHost(t.config.host, policy);
            const c = f.sftp();
            await c.connect({ host: addr!.address, port: t.config.port ?? 22, username: t.credentials?.username, password: t.credentials?.password, privateKey: t.credentials?.private_key, readyTimeout: TIMEOUT_MS });
            try {
              const path = `${String(t.config.directory).replace(/\/$/, '')}/${msg.type}-${msg.id}.json`;
              await c.put(Buffer.from(msg.body), path);
              return done({ ok: true, response: path });
            } finally {
              await c.end().catch((e: unknown) => cleanupFailed('closing the SFTP connection', e));
            }
          }
          case 'sqs': {
            await checkUrl(t.config.queue_url);
            // Never fall back to the platform's own AWS identity (env vars, instance metadata).
            if (!t.credentials?.access_key_id || !t.credentials?.secret_access_key) throw new Error('SQS endpoints need their own credentials');
            const client = f.sqs(t.config.region, t.credentials ? { accessKeyId: t.credentials.access_key_id, secretAccessKey: t.credentials.secret_access_key } : undefined);
            const fifo = String(t.config.queue_url).endsWith('.fifo');
            await client.send(
              new SendMessageCommand({
                QueueUrl: t.config.queue_url,
                MessageBody: msg.body,
                MessageAttributes: { event_id: { DataType: 'String', StringValue: msg.id }, event_type: { DataType: 'String', StringValue: msg.type } },
                ...(fifo ? { MessageGroupId: msg.type, MessageDeduplicationId: msg.id } : {}),
              }),
            );
            return done({ ok: true });
          }
        }
      } catch (e) {
        return done({ ok: false, error: e instanceof BlockedAddressError ? `blocked: ${e.message}` : errMessage(e) });
      }
    },
  };
}
