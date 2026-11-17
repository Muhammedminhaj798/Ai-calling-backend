// Local stand-in for api.sarvam.ai, for the Sarvam adapter and speech:smoke tests. Records every request
// (path, headers, JSON body or parsed multipart form) and answers with whatever the test set. Never contacts
// Sarvam.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const TEST_SARVAM_KEY = 'sk_unit_test_sarvam_0123456789abcdef';

export interface StubRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  json?: Record<string, unknown>;
  form?: FormData;
}
export interface StubReply {
  status: number;
  body: unknown;
  /** Answer after this many ms (to exercise client timeouts). */
  delayMs?: number;
}

/** `seconds` of a non-silent 16-bit square wave at `rate`. */
export function stubPcm(seconds: number, rate: number, amplitude = 3000): Buffer {
  const samples = Math.round(seconds * rate);
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  return b;
}

export async function startSarvamStub() {
  const requests: StubRequest[] = [];
  let handler: (req: StubRequest, index: number) => StubReply = () => ({ status: 200, body: {} });
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const type = req.headers['content-type'] ?? '';
      const entry: StubRequest = { path: req.url ?? '', headers: req.headers };
      if (type.startsWith('application/json')) entry.json = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      else if (type.startsWith('multipart/form-data')) entry.form = await new Response(raw, { headers: { 'content-type': type } }).formData();
      requests.push(entry);
      const reply = handler(entry, requests.length - 1);
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      };
      res.on('error', () => undefined);
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    reply(h: (req: StubRequest, index: number) => StubReply) {
      handler = h;
    },
    reset() {
      requests.length = 0;
      handler = () => ({ status: 200, body: {} });
    },
    close() {
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}
