import type { ExceptionType } from '../../generated/prisma/enums.ts';

/** Internal input used by other modules (orders, reservations, later the AI) to raise an exception. */
export interface RaiseExceptionInput {
  type: ExceptionType;
  description: string;
  callId?: string | null;
  customerId?: string | null;
  orderId?: string | null;
  orderItemId?: string | null;
  details?: unknown;
}
