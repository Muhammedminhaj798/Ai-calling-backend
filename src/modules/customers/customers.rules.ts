// Pure business rules for customers (no I/O) so they can be unit-tested directly.
import type { CustomerStatus } from '../../generated/prisma/enums.ts';

/** Only registered customers whose status is `active` proceed through the automated ordering workflow. */
export function isEligibleForAutomatedOrdering(customer: { status: CustomerStatus }): boolean {
  return customer.status === 'active';
}

export interface AddressLike {
  isDefault: boolean;
}

/** Exactly one default: keeps the first flagged default, otherwise promotes the first address. */
export function normaliseDefaultAddress<T extends AddressLike>(addresses: T[]): T[] {
  if (addresses.length === 0) return addresses;
  const firstDefault = addresses.findIndex((a) => a.isDefault);
  const keep = firstDefault === -1 ? 0 : firstDefault;
  return addresses.map((a, i) => ({ ...a, isDefault: i === keep }));
}
