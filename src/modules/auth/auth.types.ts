import type { StaffRole } from '../../generated/prisma/enums.ts';

/** Staff user as returned by the API — never includes the password hash. */
export interface SafeUser {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface AuthSession {
  accessToken: string;
  tokenType: 'Bearer';
  /** Access token lifetime in seconds */
  expiresIn: number;
  /** Cookie only: the controller sets it as the HTTP-only refresh cookie and strips it from the JSON body. */
  refreshToken: string;
  /** Cookie only (its Expires attribute), stripped from the JSON body like refreshToken. */
  refreshTokenExpiresAt: Date;
  user: SafeUser;
}
