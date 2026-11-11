// GET /health        → liveness: process is up (no dependencies checked)
// GET /health/ready  → readiness: database reachable (503 when not)
import { Router } from 'express';
import { prisma } from './config/db.ts';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString() });
});

healthRouter.get('/ready', async (_req, res) => {
  const database = await prisma.$queryRaw`SELECT 1`.then(
    () => 'up' as const,
    () => 'down' as const,
  );
  res.status(database === 'up' ? 200 : 503).json({
    status: database === 'up' ? 'ok' : 'degraded',
    checks: { database },
    timestamp: new Date().toISOString(),
  });
});
