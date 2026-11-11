// List conventions (ARCHITECTURE.md §B.1): ?page&pageSize&sort=-field → { data, page, pageSize, total }
import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type Pagination = z.infer<typeof paginationSchema>;

export interface Page<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function skipTake(p: Pagination): { skip: number; take: number } {
  return { skip: (p.page - 1) * p.pageSize, take: p.pageSize };
}

export function pageResult<T>(data: T[], total: number, p: Pagination): Page<T> {
  return { data, page: p.page, pageSize: p.pageSize, total };
}

/** "-createdAt" → desc, "name" → asc; unknown fields fall back so sort can never hit an unindexed column. */
export function parseSort<F extends string>(
  sort: string | undefined,
  allowed: readonly F[],
  fallback: F,
): { field: F; direction: 'asc' | 'desc' } {
  if (!sort) return { field: fallback, direction: 'desc' };
  const direction = sort.startsWith('-') ? 'desc' : 'asc';
  const field = (sort.startsWith('-') ? sort.slice(1) : sort) as F;
  return allowed.includes(field) ? { field, direction } : { field: fallback, direction: 'desc' };
}
