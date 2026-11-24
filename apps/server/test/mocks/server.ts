import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Minimal JSON HTTP server for the API mocks (tests and e2e only; node built-ins only). */
export interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  /** parsed JSON or form body */
  body: any;
}
export type MockReply = { status?: number; json?: unknown; headers?: Record<string, string>; redirect?: string };
export type Handler = (req: MockRequest) => MockReply | Promise<MockReply>;

export async function startMock(handler: Handler, port = 0): Promise<{ url: string; port: number; close: () => Promise<void>; server: Server }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= 5 * 1024 * 1024) chunks.push(c);
    });
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://localhost');
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      const ct = String(req.headers['content-type'] ?? '');
      try {
        body = ct.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(raw)) : raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      Promise.resolve(handler({ method: req.method ?? 'GET', path: u.pathname, query: u.searchParams, headers: req.headers, body }))
        .then((r) => {
          if (r.redirect) {
            res.writeHead(302, { location: r.redirect });
            return res.end();
          }
          res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...r.headers });
          res.end(JSON.stringify(r.json ?? {}));
        })
        .catch((e: unknown) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(e) }));
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${actual}`, port: actual, server, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
