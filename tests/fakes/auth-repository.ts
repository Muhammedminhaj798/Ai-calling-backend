// In-memory AuthRepository for unit tests, with the semantics the service relies on from PostgreSQL: reads return
// snapshots (copies, possibly stale by the time the caller acts on them, like a row read in another transaction)
// and the rotation claim is an atomic compare-and-set, as the conditional UPDATE is under row locking.
import { randomUUID } from 'node:crypto';
import type { RefreshToken, StaffUser } from '../../src/generated/prisma/client.ts';
import type { AuthRepository, NewRefreshToken } from '../../src/modules/auth/auth.repository.ts';
import { hashPassword } from '../../src/modules/auth/auth.tokens.ts';

export interface FakeAuthRepository extends AuthRepository {
  readonly tokens: Map<string, RefreshToken>;
  addUser(over?: Partial<StaffUser> & { password?: string }): Promise<StaffUser & { password: string }>;
  activeTokens(userId: string): RefreshToken[];
  /** Moves a token's revocation time into the past, to step outside the grace window without waiting. */
  backdateRevocation(id: string, ms: number): void;
}

/** Yields to the event loop, so callers that race each other all read before any of them writes. */
const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

export function createFakeAuthRepository(): FakeAuthRepository {
  const users = new Map<string, StaffUser>();
  const tokens = new Map<string, RefreshToken>();
  const insert = (data: NewRefreshToken, id: string = randomUUID()): RefreshToken => {
    const row = { id, ...data, revokedAt: null, replacedById: null, createdAt: new Date() };
    tokens.set(id, row);
    return row;
  };
  const revoke = (id: string) => {
    const t = tokens.get(id);
    if (t && !t.revokedAt) t.revokedAt = new Date();
  };

  return {
    tokens,
    async addUser({ password = 'correct horse battery staple', ...over } = {}) {
      const user: StaffUser = {
        id: randomUUID(),
        email: `user-${randomUUID().slice(0, 8)}@test.local`,
        passwordHash: await hashPassword(password),
        name: 'Test User',
        role: 'staff',
        isActive: true,
        lastLoginAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...over,
      };
      users.set(user.id, user);
      return { ...user, password };
    },
    activeTokens: (userId) => [...tokens.values()].filter((t) => t.userId === userId && !t.revokedAt),
    backdateRevocation(id, ms) {
      const t = tokens.get(id);
      if (!t?.revokedAt) throw new Error('token is not revoked');
      t.revokedAt = new Date(t.revokedAt.getTime() - ms);
    },

    async findUserByEmail(email) {
      await yieldTurn();
      const user = [...users.values()].find((u) => u.email === email);
      return user ? structuredClone(user) : null;
    },
    async findUserById(id) {
      await yieldTurn();
      const user = users.get(id);
      return user ? structuredClone(user) : null;
    },
    async touchLastLogin(id) {
      const user = users.get(id);
      if (user) user.lastLoginAt = new Date();
    },
    async createRefreshToken(data) {
      insert(data);
    },
    async findRefreshTokenByHash(tokenHash) {
      await yieldTurn();
      const token = [...tokens.values()].find((t) => t.tokenHash === tokenHash);
      const user = token && users.get(token.userId);
      return token && user ? structuredClone({ ...token, user }) : null;
    },
    async findRefreshTokenById(id) {
      await yieldTurn();
      const token = tokens.get(id);
      return token ? structuredClone(token) : null;
    },
    async rotateRefreshToken(oldId, next) {
      await yieldTurn();
      // Check and set with no await in between: the in-memory equivalent of UPDATE ... WHERE revoked_at IS NULL.
      const old = tokens.get(oldId);
      if (!old || old.revokedAt) return null;
      const created = insert(next);
      old.revokedAt = new Date();
      old.replacedById = created.id;
      return structuredClone(created);
    },
    async revokeRefreshToken(id) {
      revoke(id);
    },
    async revokeAllForUser(userId) {
      for (const t of tokens.values()) if (t.userId === userId) revoke(t.id);
    },
  };
}
