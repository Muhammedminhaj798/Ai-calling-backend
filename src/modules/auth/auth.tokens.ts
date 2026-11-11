// Password hashing (argon2id), access tokens (HS256 JWT via jose) and refresh-token material.
// Refresh tokens are random 48-byte values; only their SHA-256 hash is stored.
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';
import { env } from '../../config/env.ts';
import { StaffRole as StaffRoleValues, type StaffRole } from '../../generated/prisma/enums.ts';
import { AppError } from '../../middleware/error-handler.ts';

const ISSUER = 'ai-pharmacy-agent';
const secret = new TextEncoder().encode(env.JWT_SECRET);

export interface AccessTokenClaims {
  id: string;
  role: StaffRole;
}

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  ttlSeconds: number = env.ACCESS_TOKEN_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: claims.role })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.id)
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, algorithms: ['HS256'] });
    const role = payload['role'];
    if (typeof payload.sub !== 'string' || !isStaffRole(role)) {
      throw new AppError(401, 'UNAUTHORIZED', 'Malformed access token');
    }
    return { id: payload.sub, role };
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof joseErrors.JWTExpired) throw new AppError(401, 'TOKEN_EXPIRED', 'Access token expired');
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid access token');
  }
}

function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === 'string' && (Object.values(StaffRoleValues) as string[]).includes(value);
}

export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
