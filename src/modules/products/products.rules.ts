// Pure product rules (no I/O).

export interface ProductIdentity {
  name: string;
  strength?: string | null | undefined;
  packSize?: string | null | undefined;
  manufacturer?: string | null | undefined;
}

const norm = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Two catalogue rows describe the same sellable product when name, strength, pack size and
 * manufacturer agree (case/whitespace-insensitive). Different SKUs with the same key are duplicates.
 */
export function productDuplicateKey(p: ProductIdentity): string {
  return [norm(p.name), norm(p.strength), norm(p.packSize), norm(p.manufacturer)].join('|');
}

/** Exact identification: the query equals the SKU or the full product name (case-insensitive). */
export function isExactProductMatch(p: { externalCode: string; name: string }, query: string): boolean {
  const q = norm(query);
  return norm(p.externalCode) === q || norm(p.name) === q;
}
