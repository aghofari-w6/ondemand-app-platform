import { backoffMs } from '@aod/shared';
import { describe, expect, it } from 'vitest';
import { createDelivery, signWebhook, verifyWebhook, type ClientFactories } from './delivery.ts';
import { checkHost, isPrivateAddress, policyFrom, safeLookup } from './ssrf.ts';

const strict = policyFrom('', false);
const msg = { id: 'evt_1', type: 'order.created', timestamp: new Date(), body: '{"a":1}' };

describe('SSRF policy', () => {
  it('classifies addresses', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.0.1', '100.64.1.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2001:db8::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('rejects hosts that resolve to private addresses unless explicitly allowed (dev/test only)', async () => {
    await expect(checkHost('localhost', strict)).rejects.toThrow(/private or reserved/);
    await expect(checkHost('127.0.0.1', strict)).rejects.toThrow();
    await expect(checkHost('localhost', policyFrom('localhost', false))).resolves.toBeDefined();
    expect(policyFrom('localhost', true).allow.size).toBe(0); // never in production
    await expect(new Promise((res, rej) => safeLookup(strict)('localhost', {}, (err: Error | null) => (err ? rej(err) : res(null))))).rejects.toThrow(/private/);
  });
});

describe('backoff and signatures', () => {
  it('grows exponentially with jitter inside [ceiling/2, ceiling]', () => {
    const lo = [0, 1, 2, 3].map((a) => backoffMs(a, { baseMs: 1000, random: () => 0 }));
    const hi = [0, 1, 2, 3].map((a) => backoffMs(a, { baseMs: 1000, random: () => 0.999999 }));
    expect(lo).toEqual([500, 1000, 2000, 4000]);
    expect(hi).toEqual([999, 1999, 3999, 7999]);
    expect(backoffMs(30, { baseMs: 1000, capMs: 60_000, random: () => 0 })).toBe(30_000);
  });

  it('signs and verifies Standard Webhooks', () => {
    const secret = `whsec_${Buffer.from('0123456789abcdef0123').toString('base64')}`;
    const ts = Math.floor(Date.now() / 1000);
    const sig = signWebhook(secret, 'msg_1', ts, '{"x":1}');
    expect(verifyWebhook(secret, { 'webhook-id': 'msg_1', 'webhook-timestamp': String(ts), 'webhook-signature': sig }, '{"x":1}')).toBe(true);
    expect(verifyWebhook(secret, { 'webhook-id': 'msg_1', 'webhook-timestamp': String(ts), 'webhook-signature': sig }, '{"x":2}')).toBe(false);
    expect(verifyWebhook(secret, { 'webhook-id': 'msg_1', 'webhook-timestamp': String(ts - 3600), 'webhook-signature': signWebhook(secret, 'msg_1', ts - 3600, '{"x":1}') }, '{"x":1}')).toBe(false);
  });
});

describe('transports (fake clients)', () => {
  const calls: Record<string, any[]> = { kafka: [], sftp: [], sqs: [] };
  const factories: ClientFactories = {
    kafka: (cfg) => ({ producer: () => ({ connect: async () => void calls.kafka!.push({ cfg }), send: async (r: any) => void calls.kafka!.push(r), disconnect: async () => {} }) }),
    redis: () => ({ xadd: async () => '1-0', quit: async () => 'OK' }),
    sftp: () => ({ connect: async (o: any) => void calls.sftp!.push(o), put: async (b: Buffer, path: string) => void calls.sftp!.push({ path, body: b.toString() }), end: async () => true }),
    sqs: () => ({ send: async (cmd: any) => void calls.sqs!.push(cmd.input) }),
  };
  const d = createDelivery(strict, { production: false, factories });

  it('produces to Kafka with the event id as key', async () => {
    const r = await d.deliver({ kind: 'kafka', config: { brokers: ['93.184.216.34:9092'], topic: 'orders', ssl: true }, credentials: { mechanism: 'scram-sha-256', username: 'u', password: 'p' } }, msg);
    expect(r.ok).toBe(true);
    expect(calls.kafka![0].cfg.sasl).toMatchObject({ mechanism: 'scram-sha-256', username: 'u' });
    expect(calls.kafka![1]).toMatchObject({ topic: 'orders', messages: [{ key: 'evt_1', value: '{"a":1}' }] });
    const bad = await d.deliver({ kind: 'kafka', config: { brokers: ['10.0.0.9:9092'], topic: 'x', ssl: true }, credentials: null }, msg);
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/^blocked/) });
  });

  it('uploads to SFTP at the checked address', async () => {
    const r = await d.deliver({ kind: 'sftp', config: { host: '93.184.216.34', port: 22, directory: '/in/' }, credentials: { username: 'u', password: 'p' } }, msg);
    expect(r).toMatchObject({ ok: true, response: '/in/order.created-evt_1.json' });
    expect(calls.sftp![0]).toMatchObject({ host: '93.184.216.34', username: 'u' });
  });

  it('sends to SQS with dedup on FIFO queues', async () => {
    const r = await d.deliver({ kind: 'sqs', config: { queue_url: 'https://93.184.216.34/123/orders.fifo', region: 'us-east-1' }, credentials: { access_key_id: 'a', secret_access_key: 's' } }, msg);
    expect(r.ok).toBe(true);
    expect(calls.sqs![0]).toMatchObject({ MessageBody: '{"a":1}', MessageDeduplicationId: 'evt_1', MessageGroupId: 'order.created' });
  });

  it('refuses http URLs and private targets at check time', async () => {
    await expect(d.checkTarget({ kind: 'webhook', config: { url: 'http://93.184.216.34/x' }, credentials: null })).rejects.toThrow(/https/);
    await expect(d.checkTarget({ kind: 'sftp', config: { host: '192.168.1.1', directory: '/' }, credentials: { username: 'u', password: 'p' } })).rejects.toThrow(/private/);
  });
});
