// Process entry: validate config, start the HTTP server, the telephony media WebSocket, the reservation
// expiry sweeper and the idle-conversation sweeper; shut down cleanly on SIGINT/SIGTERM.
import http from 'node:http';
import { createApp } from './app.ts';
import { prisma } from './config/db.ts';
import { env } from './config/env.ts';
import { attachTelephonyWebSocket } from './media-server.ts';
import { callsService } from './modules/calls/calls.service.ts';
import { reservationsService } from './modules/orders/reservations.service.ts';
import { logger } from './utils/logger.ts';

const server = http.createServer(createApp());
// Telephony media stream: wss://<host>/ws/telephony/<provider>/<secret>
const wss = attachTelephonyWebSocket(server);

server.listen(env.PORT, () => {
  logger.info('server.listening', {
    port: env.PORT,
    env: env.NODE_ENV,
    inventoryAdapter: env.INVENTORY_ADAPTER,
    aiProvider: env.AI_PROVIDER,
    stt: env.STT_PROVIDER,
    tts: env.TTS_PROVIDER,
    telephony: env.TELEPHONY_PROVIDER,
  });
});

// ponytail: in-process intervals; move to a job queue only when more than one backend instance runs (§B.7).
const timers: NodeJS.Timeout[] = [];
if (env.RESERVATION_SWEEP_INTERVAL_SECONDS > 0) {
  timers.push(
    setInterval(() => {
      reservationsService
        .expireOverdue()
        .then((r) => {
          if (r.reservations > 0) logger.info('reservations.expired', r);
        })
        .catch((err: unknown) => logger.error('reservations.sweep_failed', { message: err instanceof Error ? err.message : String(err) }));
    }, env.RESERVATION_SWEEP_INTERVAL_SECONDS * 1000),
  );
  timers.push(
    setInterval(() => {
      callsService
        .closeIdleSessions(env.CONVERSATION_IDLE_TIMEOUT_MINUTES * 60_000)
        .then((n) => {
          if (n > 0) logger.info('conversations.idle_closed', { count: n });
        })
        .catch((err: unknown) => logger.error('conversations.sweep_failed', { message: err instanceof Error ? err.message : String(err) }));
    }, 60_000),
  );
}
for (const t of timers) t.unref();

function shutdown(signal: NodeJS.Signals): void {
  logger.info('server.shutdown', { signal });
  for (const t of timers) clearInterval(t);
  wss.close();
  server.close(() => {
    prisma.$disconnect().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
