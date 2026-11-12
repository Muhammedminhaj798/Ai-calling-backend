// Shared helpers for PostgreSQL-backed integration tests. Run through `npm run test:integration`,
// which verifies the test database is separate (scripts/db-guard.ts), points DATABASE_URL at it, applies
// migrations first and runs the suite files serially (--test-concurrency=1): they share one database and
// resetDb() truncates it between tests.
import '../env.ts';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { integrationGate } from '../../scripts/db-guard.ts';
import type { CustomerStatus, StaffRole } from '../../src/generated/prisma/enums.ts';

// Suites skip (and nothing is truncated) unless the runner's guard verified this exact database.
const gate = integrationGate(process.env);
export const dbAvailable = gate.available;
export const skipReason = gate.reason;

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const { createApp } = await import('../../src/app.ts');
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function db() {
  const { prisma } = await import('../../src/config/db.ts');
  return prisma;
}

/** Empties every table touched by these tests. Safe only against the dedicated test database. */
export async function resetDb(): Promise<void> {
  if (!dbAvailable) throw new Error(`refusing to truncate: ${skipReason}`);
  const prisma = await db();
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE order_events, order_confirmations, stock_reservations, order_items, orders, staff_approvals, exceptions, ' +
      'refresh_tokens, audit_logs, customer_addresses, customers, inventory, products, staff_users RESTART IDENTITY CASCADE',
  );
}

export async function disconnectDb(): Promise<void> {
  await (await db()).$disconnect();
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  role: StaffRole;
}

export async function createUser(role: StaffRole, overrides: { email?: string; password?: string; isActive?: boolean } = {}): Promise<TestUser> {
  const { hashPassword } = await import('../../src/modules/auth/auth.tokens.ts');
  const prisma = await db();
  const email = overrides.email ?? `${role}-${randomUUID().slice(0, 8)}@test.local`;
  const password = overrides.password ?? 'correct horse battery staple';
  const user = await prisma.staffUser.create({
    data: { email, name: `${role} user`, role, passwordHash: await hashPassword(password), isActive: overrides.isActive ?? true },
  });
  return { id: user.id, email: user.email, password, role };
}

let phoneCounter = 0;
/** Creates a customer directly in the database (status active unless overridden). */
export async function createCustomer(overrides: { status?: CustomerStatus; externalCode?: string; name?: string } = {}) {
  const prisma = await db();
  phoneCounter++;
  return prisma.customer.create({
    data: {
      externalCode: overrides.externalCode ?? `C-${randomUUID().slice(0, 8)}`,
      name: overrides.name ?? 'Test Pharmacy',
      phonePrimary: `+9190000${String(phoneCounter).padStart(5, '0')}`,
      status: overrides.status ?? 'active',
    },
  });
}

/** Creates a product and, unless `stock` is null, a mock inventory row with that available quantity. */
export async function createProduct(
  sku: string,
  stock: number | null,
  overrides: Partial<{ name: string; strength: string | null; packSize: string; manufacturer: string; ptrPaise: number | null; status: 'active' | 'inactive' | 'discontinued'; reserved: number }> = {},
) {
  const prisma = await db();
  const product = await prisma.product.create({
    data: {
      externalCode: sku,
      name: overrides.name ?? `Product ${sku}`,
      brand: 'TestBrand',
      genericName: 'Generic',
      strength: overrides.strength === undefined ? '500 mg' : overrides.strength,
      form: 'tablet',
      packSize: overrides.packSize ?? '10x10',
      unit: 'strip',
      manufacturer: overrides.manufacturer ?? 'Test Labs',
      ptrPaise: overrides.ptrPaise === undefined ? 2600 : overrides.ptrPaise,
      status: overrides.status ?? 'active',
    },
  });
  if (stock !== null) {
    await prisma.inventory.create({
      data: { productId: product.id, quantityAvailable: stock, quantityReserved: overrides.reserved ?? 0, source: 'mock', syncedAt: new Date() },
    });
  }
  return product;
}

export async function reservedQuantity(sku: string): Promise<number> {
  const prisma = await db();
  const row = await prisma.inventory.findFirst({ where: { product: { externalCode: sku } } });
  return row?.quantityReserved ?? -1;
}

export interface ApiResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  text: string;
  headers: Headers;
  setCookies: string[];
}

export interface RequestOptions {
  body?: unknown;
  token?: string;
  cookie?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export function api(baseUrl: string) {
  async function request(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = opts.contentType ?? 'application/json';
      body = opts.contentType ? String(opts.body) : JSON.stringify(opts.body);
    }
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
    if (opts.cookie) headers['cookie'] = opts.cookie;
    const res = await fetch(baseUrl + path, { method, headers, body });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed, text, headers: res.headers, setCookies: res.headers.getSetCookie() };
  }
  return {
    get: (path: string, opts?: RequestOptions) => request('GET', path, opts),
    post: (path: string, body?: unknown, opts?: RequestOptions) => request('POST', path, { ...opts, body }),
    patch: (path: string, body?: unknown, opts?: RequestOptions) => request('PATCH', path, { ...opts, body }),
    delete: (path: string, opts?: RequestOptions) => request('DELETE', path, opts),
  };
}
export type ApiClient = ReturnType<typeof api>;

export interface Session {
  user: TestUser;
  accessToken: string;
  refreshToken: string;
  /** Cookie header value carrying the refresh token */
  cookie: string;
}

export function refreshCookie(setCookies: string[]): string {
  const raw = setCookies.find((c) => c.startsWith('refresh_token='));
  if (!raw) throw new Error('refresh_token cookie not set');
  return raw.split(';')[0]!;
}

export async function loginAs(client: ApiClient, role: StaffRole): Promise<Session> {
  const user = await createUser(role);
  const res = await client.post('/api/auth/login', { email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.text}`);
  return { user, accessToken: res.body.accessToken, refreshToken: res.body.refreshToken, cookie: refreshCookie(res.setCookies) };
}
