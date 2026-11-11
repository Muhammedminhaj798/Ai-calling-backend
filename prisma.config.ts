// Prisma 7 configuration. The datasource URL lives here, not in schema.prisma.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // The CLI (migrations) should use a direct connection; Prisma Migrate's session-level advisory lock
    // misbehaves behind transaction-mode poolers such as Neon's "-pooler" endpoint. The application itself
    // keeps using DATABASE_URL (see src/config/db.ts).
    url: process.env['DIRECT_DATABASE_URL'] ?? process.env['DATABASE_URL'],
  },
});
