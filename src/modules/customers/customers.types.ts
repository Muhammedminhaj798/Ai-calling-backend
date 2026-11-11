import type { Customer, CustomerAddress } from '../../generated/prisma/client.ts';

export type CustomerWithAddresses = Customer & { addresses: CustomerAddress[] };

export interface CustomerLookupResult {
  customer: CustomerWithAddresses;
  /** Only registered, active customers go through the automated ordering workflow. */
  eligibleForAutomatedOrdering: boolean;
}

export interface ImportRowError {
  field?: string;
  message: string;
}

export interface ImportSummary {
  total: number;
  create: number;
  update: number;
  error: number;
}

export interface ImportResult<Row> {
  summary: ImportSummary;
  applied: { created: number; updated: number };
  rows: Row[];
}
