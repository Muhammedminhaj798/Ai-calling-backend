import type { ProductStatus } from '../../generated/prisma/enums.ts';

/** One ranked catalogue candidate. `exact` is true only for an exact SKU or full-name match. */
export interface ProductSearchCandidate {
  id: string;
  externalCode: string;
  name: string;
  brand: string | null;
  genericName: string | null;
  strength: string | null;
  form: string | null;
  packSize: string | null;
  unit: string | null;
  manufacturer: string | null;
  status: ProductStatus;
  /** pg_trgm similarity, 0–1 */
  score: number;
  exact: boolean;
}

/**
 * Search never selects a product. `exactMatch` is set only when exactly one candidate matches the
 * query exactly; even then the caller must confirm name, strength and pack size with the customer.
 */
export interface ProductSearchResult {
  query: string;
  exactMatch: ProductSearchCandidate | null;
  candidates: ProductSearchCandidate[];
}
