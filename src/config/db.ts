// Single Prisma client for the process. Prisma 7 runs without the Rust engine and
// talks to PostgreSQL through the pg driver adapter.
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.ts';
import { env } from './env.ts';

const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  // Remote databases (Neon) can take several seconds to accept a new connection after idling; 5 s was too short.
  connectionTimeoutMillis: 30_000,
});

export const prisma = new PrismaClient({
  adapter,
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  // Interactive transactions (order creation, imports, reservations) span many round-trips; against a
  // remote database such as Neon the 5 s default expires mid-transaction.
  transactionOptions: { maxWait: 10_000, timeout: 60_000 },
});
