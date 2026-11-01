import { randomUUID } from 'node:crypto';
import { Kafka } from 'kafkajs';
import SftpClient from 'ssh2-sftp-client';
import { describe, expect, it } from 'vitest';
import { createDelivery } from '../src/adapters/delivery.ts';
import { policyFrom } from '../src/adapters/ssrf.ts';

/**
 * Hub transports against real services (test-only containers started by CI: Redpanda for
 * Kafka, atmoz/sftp for SFTP). They run where the services are provided
 * (`TEST_KAFKA_BROKERS`, `TEST_SFTP=host:port`, `TEST_SFTP_USER`, `TEST_SFTP_PASSWORD`);
 * the fake-client tests in `adapters/delivery.test.ts` cover the same paths everywhere.
 */
const KAFKA = process.env.TEST_KAFKA_BROKERS;
const SFTP = process.env.TEST_SFTP;
// The test containers listen on loopback, which production never allows.
const delivery = createDelivery(policyFrom('localhost,127.0.0.1', false), { production: false });

describe.runIf(KAFKA)('Kafka (Redpanda)', () => {
  it('produces the event with its id as key and headers, through the SSRF-policed socket factory', async () => {
    const topic = `aod-test-${randomUUID().slice(0, 8)}`;
    const brokers = KAFKA!.split(',');
    const admin = new Kafka({ clientId: 'aod-test-admin', brokers }).admin();
    await admin.connect();
    await admin.createTopics({ topics: [{ topic, numPartitions: 1 }] });
    await admin.disconnect();

    const msg = { id: randomUUID(), type: 'order.created', timestamp: new Date(), body: JSON.stringify({ hello: 'kafka' }) };
    const r = await delivery.deliver({ kind: 'kafka', config: { brokers, topic, ssl: false }, credentials: null }, msg);
    expect(r).toMatchObject({ ok: true });

    const consumer = new Kafka({ clientId: 'aod-test-consumer', brokers }).consumer({ groupId: `aod-test-${randomUUID()}` });
    await consumer.connect();
    try {
      await consumer.subscribe({ topic, fromBeginning: true });
      const got = await new Promise<{ key: string; value: string; type: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no message within 20 s')), 20_000);
        consumer
          .run({
            eachMessage: async ({ message }) => {
              clearTimeout(timer);
              resolve({ key: String(message.key), value: String(message.value), type: String(message.headers?.['event-type']) });
            },
          })
          .catch(reject);
      });
      expect(got).toEqual({ key: msg.id, value: msg.body, type: 'order.created' });
    } finally {
      await consumer.disconnect();
    }
  }, 60_000);
});

describe.runIf(SFTP)('SFTP (atmoz/sftp)', () => {
  it('uploads one file per event into the configured directory', async () => {
    const [host, port] = SFTP!.split(':') as [string, string];
    const credentials = { username: process.env.TEST_SFTP_USER ?? 'aod', password: process.env.TEST_SFTP_PASSWORD };
    const msg = { id: randomUUID(), type: 'order.created', timestamp: new Date(), body: JSON.stringify({ hello: 'sftp' }) };
    const r = await delivery.deliver({ kind: 'sftp', config: { host, port: Number(port), directory: '/upload/' }, credentials }, msg);
    expect(r).toMatchObject({ ok: true, response: `/upload/order.created-${msg.id}.json` });

    const c = new SftpClient('aod-test');
    await c.connect({ host, port: Number(port), username: credentials.username, password: credentials.password });
    try {
      expect(String(await c.get(`/upload/order.created-${msg.id}.json`))).toBe(msg.body);
    } finally {
      await c.end();
    }
  }, 60_000);
});
