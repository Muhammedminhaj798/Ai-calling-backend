import type { ItemStockStatus, OrderStatus, ReservationStatus } from '../../generated/prisma/enums.ts';
import type { AuthUser } from '../../middleware/auth.ts';

/** Who performed an action on an order. The AI (step 4) acts as `ai`; the expiry sweeper as `system`. */
export interface Actor {
  type: 'staff' | 'system' | 'ai';
  id?: string | null;
}

export const SYSTEM_ACTOR: Actor = { type: 'system', id: null };
export const staffActor = (user: AuthUser): Actor => ({ type: 'staff', id: user.id });
export const actorFields = (actor: Actor) => ({ actorType: actor.type, actorId: actor.id ?? null });

export interface ReadbackLine {
  itemId: string;
  lineNo: number;
  productId: string;
  sku: string;
  name: string;
  strength: string | null;
  form: string | null;
  packSize: string | null;
  unit: string | null;
  quantity: number;
}

export interface ReadbackResult {
  confirmationId: string;
  orderId: string;
  revision: number;
  status: OrderStatus;
  lines: ReadbackLine[];
  /** Unresolved requests are listed for the agent but are not read back as products. */
  flaggedRequests: Array<{ itemId: string; requestedText: string; quantity: number; flagReason: string | null }>;
  readbackText: string;
}

export interface LineAvailability {
  itemId: string;
  sku: string;
  quantity: number;
  availableToSell: number | null;
  status: Extract<ItemStockStatus, 'in_stock' | 'insufficient' | 'out_of_stock' | 'unknown'>;
}

export interface ReservationSummary {
  id: string;
  orderItemId: string;
  productId: string;
  quantity: number;
  status: ReservationStatus;
  provider: string;
  externalReservationRef: string | null;
  expiresAt: Date;
  releasedAt: Date | null;
}

export type ReservationFailureReason = 'insufficient_stock' | 'out_of_stock' | 'unknown_sku' | 'provider_partial';

export type ReservationOutcome =
  | {
      outcome: 'reserved';
      orderStatus: OrderStatus;
      /** True when an identical Idempotency-Key was replayed and nothing new was reserved */
      replay: boolean;
      source: string;
      isMock: boolean;
      expiresAt: Date | null;
      lines: LineAvailability[];
      reservations: ReservationSummary[];
    }
  | {
      outcome: 'failed';
      orderStatus: OrderStatus;
      reason: ReservationFailureReason;
      source: string;
      isMock: boolean;
      lines: LineAvailability[];
      exceptionId: string;
    };
