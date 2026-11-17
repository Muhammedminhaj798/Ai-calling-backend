// Attaches the telephony media WebSocket to an HTTP server: wss://<host>/ws/telephony/<provider>/<secret>.
// Shared by server.ts and the integration tests.
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { env } from './config/env.ts';
import type { TelephonyAdapter } from './integrations/telephony/telephony.port.ts';
import { attachMediaStream } from './modules/telephony/telephony.media.ts';
import { getTelephonyAdapter } from './modules/telephony/telephony.service.ts';

function notFound(socket: Duplex): void {
  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
}

export function attachTelephonyWebSocket(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let adapter: TelephonyAdapter;
    try {
      adapter = getTelephonyAdapter();
    } catch {
      // No phone line (TELEPHONY_PROVIDER=none) or mock telephony in production: no media stream is accepted.
      return notFound(socket);
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = url.pathname.match(/^\/ws\/telephony\/([a-z]+)\/([^/]+)$/);
    const expected = env.TELEPHONY_PROVIDER === 'exotel' ? env.EXOTEL_WEBHOOK_SECRET! : 'mock';
    const given = match?.[2] ?? '';
    const ok = match && match[1] === adapter.name && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok) return notFound(socket);
    wss.handleUpgrade(req, socket, head, (ws) => attachMediaStream(ws, adapter));
  });
  return wss;
}
