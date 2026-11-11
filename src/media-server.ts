// Attaches the telephony media WebSocket to an HTTP server: wss://<host>/ws/telephony/<provider>/<secret>.
// Shared by server.ts and the integration tests.
import type http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { env } from './config/env.ts';
import { attachMediaStream } from './modules/telephony/telephony.media.ts';
import { getTelephonyAdapter } from './modules/telephony/telephony.service.ts';

export function attachTelephonyWebSocket(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = url.pathname.match(/^\/ws\/telephony\/([a-z]+)\/([^/]+)$/);
    const adapter = getTelephonyAdapter();
    const expected = env.TELEPHONY_PROVIDER === 'exotel' ? env.EXOTEL_WEBHOOK_SECRET! : 'mock';
    const given = match?.[2] ?? '';
    const ok = match && match[1] === adapter.name && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachMediaStream(ws, adapter));
  });
  return wss;
}
