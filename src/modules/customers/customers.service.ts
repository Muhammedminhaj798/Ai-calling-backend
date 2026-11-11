// Customer business rules: duplicate prevention, status/eligibility, addresses, CSV import.
import type { Prisma } from '../../generated/prisma/client.ts';
import type { AuthUser } from '../../middleware/auth.ts';
import { AppError } from '../../middleware/error-handler.ts';
import { audit, type RequestMeta } from '../../utils/audit.ts';
import { parseCsv } from '../../utils/csv.ts';
import { pageResult, parseSort, skipTake, type Page } from '../../utils/pagination.ts';
import { normalizePhone } from '../../utils/phone.ts';
import {
  analyzeCustomerImport,
  CUSTOMER_CSV_REQUIRED,
  summarise,
  type CustomerImportPlan,
  type CustomerImportRow,
} from './customers.import.ts';
import { customersRepository as repo } from './customers.repository.ts';
import { isEligibleForAutomatedOrdering, normaliseDefaultAddress } from './customers.rules.ts';
import type { CustomerLookupResult, CustomerWithAddresses, ImportResult } from './customers.types.ts';
import type {
  AddressInput,
  CreateCustomerInput,
  ListCustomersQuery,
  UpdateCustomerInput,
} from './customers.validation.ts';

const MAX_IMPORT_ROWS = 5_000;
const SORTABLE = ['createdAt', 'name', 'externalCode'] as const;

async function assertNoDuplicates(input: { externalCode?: string; phones: string[] }, selfId?: string): Promise<void> {
  if (input.externalCode) {
    const byCode = await repo.findByExternalCode(input.externalCode);
    if (byCode && byCode.id !== selfId) {
      throw new AppError(409, 'DUPLICATE_EXTERNAL_CODE', `Customer code ${input.externalCode} already exists`, {
        conflictingCustomerId: byCode.id,
      });
    }
  }
  if (input.phones.length > 0) {
    const owners = (await repo.findByPhones(input.phones)).filter((c) => c.id !== selfId);
    if (owners.length > 0) {
      throw new AppError(409, 'DUPLICATE_PHONE', 'A phone number is already registered to another customer', {
        conflictingCustomerId: owners[0]!.id,
        phones: owners.flatMap((c) => [c.phonePrimary, ...c.phoneAlternates].filter((p) => input.phones.includes(p))),
      });
    }
  }
}

function toCreateData(input: CreateCustomerInput): Prisma.CustomerCreateInput {
  const { addresses, ...fields } = input;
  const normalised = normaliseDefaultAddress(addresses);
  return { ...fields, addresses: normalised.length > 0 ? { create: normalised } : undefined };
}

function toUpdateData(input: UpdateCustomerInput): Prisma.CustomerUpdateInput {
  return { ...input };
}

async function getOrThrow(id: string): Promise<CustomerWithAddresses> {
  const customer = await repo.findById(id);
  if (!customer) throw new AppError(404, 'NOT_FOUND', 'Customer not found');
  return customer;
}

function parseImportCsv(csvText: unknown): Record<string, string>[] {
  if (typeof csvText !== 'string' || csvText.trim() === '') {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the CSV file as the request body with Content-Type: text/csv');
  }
  const { headers, rows } = parseCsv(csvText);
  const missing = CUSTOMER_CSV_REQUIRED.filter((c) => !headers.includes(c));
  if (missing.length > 0) {
    throw new AppError(400, 'CSV_MISSING_COLUMNS', `CSV is missing required columns: ${missing.join(', ')}`, { missing });
  }
  if (rows.length === 0) throw new AppError(400, 'CSV_EMPTY', 'CSV has a header but no data rows');
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new AppError(413, 'CSV_TOO_LARGE', `CSV has ${rows.length} rows; the limit is ${MAX_IMPORT_ROWS} per import`);
  }
  return rows;
}

async function planImport(csvText: unknown): Promise<CustomerImportPlan> {
  const rows = parseImportCsv(csvText);
  const existing = (await repo.allRefs()).map((c) => ({
    id: c.id,
    externalCode: c.externalCode,
    phones: [c.phonePrimary, ...c.phoneAlternates],
  }));
  return analyzeCustomerImport(rows, existing);
}

export const customersService = {
  async list(query: ListCustomersQuery): Promise<Page<CustomerWithAddresses>> {
    const and: Prisma.CustomerWhereInput[] = [];
    if (query.status) and.push({ status: query.status });
    if (query.preferredLanguage) and.push({ preferredLanguage: query.preferredLanguage });
    if (query.q) {
      const phone = normalizePhone(query.q);
      and.push({
        OR: [
          { name: { contains: query.q, mode: 'insensitive' } },
          { externalCode: { contains: query.q, mode: 'insensitive' } },
          ...(phone ? [{ phonePrimary: phone }, { phoneAlternates: { has: phone } }] : []),
        ],
      });
    }
    const sort = parseSort(query.sort, SORTABLE, 'createdAt');
    const { skip, take } = skipTake(query);
    const [data, total] = await repo.list(and.length ? { AND: and } : {}, { [sort.field]: sort.direction }, skip, take);
    return pageResult(data, total, query);
  },

  getById: getOrThrow,

  async findByPhone(phone: string): Promise<CustomerLookupResult> {
    const customer = await repo.findByPhone(phone);
    if (!customer) throw new AppError(404, 'NOT_FOUND', 'No customer registered with this phone number');
    return { customer, eligibleForAutomatedOrdering: isEligibleForAutomatedOrdering(customer) };
  },

  async create(input: CreateCustomerInput, actor: AuthUser, meta: RequestMeta): Promise<CustomerWithAddresses> {
    await assertNoDuplicates({ externalCode: input.externalCode, phones: [input.phonePrimary, ...input.phoneAlternates] });
    const customer = await repo.create(toCreateData(input));
    await audit({ actorType: 'staff', actorId: actor.id, action: 'customer.create', entityType: 'customer', entityId: customer.id, after: input, ...meta });
    return customer;
  },

  async update(id: string, input: UpdateCustomerInput, actor: AuthUser, meta: RequestMeta): Promise<CustomerWithAddresses> {
    const existing = await getOrThrow(id);
    const phones = [
      ...(input.phonePrimary ? [input.phonePrimary] : []),
      ...(input.phoneAlternates ?? []),
    ];
    await assertNoDuplicates({ externalCode: input.externalCode, phones }, id);
    const updated = await repo.update(id, toUpdateData(input));
    const changedKeys = Object.keys(input) as (keyof UpdateCustomerInput)[];
    await audit({
      actorType: 'staff',
      actorId: actor.id,
      action: input.status && input.status !== existing.status ? 'customer.status_change' : 'customer.update',
      entityType: 'customer',
      entityId: id,
      before: Object.fromEntries(changedKeys.map((k) => [k, existing[k]])),
      after: input,
      ...meta,
    });
    return updated;
  },

  async addAddress(id: string, input: AddressInput, actor: AuthUser, meta: RequestMeta) {
    const customer = await getOrThrow(id);
    const isDefault = input.isDefault || customer.addresses.length === 0;
    const address = await repo.createAddress(id, { ...input, isDefault });
    await audit({ actorType: 'staff', actorId: actor.id, action: 'customer.address_add', entityType: 'customer', entityId: id, after: address, ...meta });
    return address;
  },

  async updateAddress(id: string, addressId: string, input: Partial<AddressInput>, actor: AuthUser, meta: RequestMeta) {
    const existing = await repo.findAddress(id, addressId);
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Address not found');
    if (input.isDefault === false && existing.isDefault) {
      throw new AppError(400, 'DEFAULT_ADDRESS_REQUIRED', 'Mark another address as default instead of unsetting this one');
    }
    const address = await repo.updateAddress(id, addressId, input);
    await audit({ actorType: 'staff', actorId: actor.id, action: 'customer.address_update', entityType: 'customer', entityId: id, before: existing, after: address, ...meta });
    return address;
  },

  async deleteAddress(id: string, addressId: string, actor: AuthUser, meta: RequestMeta): Promise<void> {
    const existing = await repo.findAddress(id, addressId);
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Address not found');
    await repo.deleteAddress(id, addressId);
    await audit({ actorType: 'staff', actorId: actor.id, action: 'customer.address_delete', entityType: 'customer', entityId: id, before: existing, ...meta });
  },

  previewImport: (csvText: unknown): Promise<CustomerImportPlan> => planImport(csvText),

  async import(csvText: unknown, strict: boolean, actor: AuthUser, meta: RequestMeta): Promise<ImportResult<CustomerImportRow>> {
    const plan = await planImport(csvText);
    if (strict && plan.summary.error > 0) {
      throw new AppError(400, 'IMPORT_HAS_ERRORS', `${plan.summary.error} row(s) have errors; fix them or import without strict=true`, plan);
    }
    const applied = await repo.applyImport(
      plan.rows,
      (row) => toCreateData(row.input!),
      (row) => {
        const { addresses: _addresses, ...fields } = row.input!;
        return toUpdateData(fields);
      },
    );
    await audit({
      actorType: 'staff',
      actorId: actor.id,
      action: 'customer.import',
      entityType: 'customer',
      after: { ...applied, skipped: plan.summary.error, rows: plan.summary.total },
      ...meta,
    });
    return { summary: summarise(plan.rows), applied, rows: plan.rows.filter((r) => r.errors.length > 0) };
  },
};
