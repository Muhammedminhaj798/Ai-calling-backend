// Prisma queries for customers and their delivery addresses. No business rules here.
import { prisma } from '../../config/db.ts';
import type { Prisma } from '../../generated/prisma/client.ts';
import type { CustomerImportRow } from './customers.import.ts';

const withAddresses = {
  addresses: { orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] },
} satisfies Prisma.CustomerInclude;

const refSelect = { id: true, externalCode: true, phonePrimary: true, phoneAlternates: true } satisfies Prisma.CustomerSelect;

export const customersRepository = {
  list(where: Prisma.CustomerWhereInput, orderBy: Prisma.CustomerOrderByWithRelationInput, skip: number, take: number) {
    return Promise.all([
      prisma.customer.findMany({ where, orderBy, skip, take, include: withAddresses }),
      prisma.customer.count({ where }),
    ]);
  },
  findById: (id: string) => prisma.customer.findUnique({ where: { id }, include: withAddresses }),
  findByExternalCode: (externalCode: string) => prisma.customer.findUnique({ where: { externalCode } }),
  findByPhone: (phone: string) =>
    prisma.customer.findFirst({
      where: { OR: [{ phonePrimary: phone }, { phoneAlternates: { has: phone } }] },
      include: withAddresses,
    }),
  /** Customers owning any of the given phones (primary or alternate). */
  findByPhones: (phones: string[]) =>
    prisma.customer.findMany({
      where: { OR: [{ phonePrimary: { in: phones } }, { phoneAlternates: { hasSome: phones } }] },
      select: refSelect,
    }),
  allRefs: () => prisma.customer.findMany({ select: refSelect }),

  create: (data: Prisma.CustomerCreateInput) => prisma.customer.create({ data, include: withAddresses }),
  update: (id: string, data: Prisma.CustomerUpdateInput) =>
    prisma.customer.update({ where: { id }, data, include: withAddresses }),

  findAddress: (customerId: string, addressId: string) =>
    prisma.customerAddress.findFirst({ where: { id: addressId, customerId } }),
  /** Creates an address; when it is the default, clears the flag on the customer's other addresses. */
  createAddress: (customerId: string, data: Omit<Prisma.CustomerAddressCreateWithoutCustomerInput, 'customer'>) =>
    prisma.$transaction(async (tx) => {
      if (data.isDefault) await tx.customerAddress.updateMany({ where: { customerId }, data: { isDefault: false } });
      return tx.customerAddress.create({ data: { ...data, customer: { connect: { id: customerId } } } });
    }),
  updateAddress: (customerId: string, addressId: string, data: Prisma.CustomerAddressUpdateInput) =>
    prisma.$transaction(async (tx) => {
      if (data.isDefault === true) {
        await tx.customerAddress.updateMany({ where: { customerId, id: { not: addressId } }, data: { isDefault: false } });
      }
      return tx.customerAddress.update({ where: { id: addressId }, data });
    }),
  /** Deletes an address; if it was the default, promotes the oldest remaining address. */
  deleteAddress: (customerId: string, addressId: string) =>
    prisma.$transaction(async (tx) => {
      const removed = await tx.customerAddress.delete({ where: { id: addressId } });
      if (removed.isDefault) {
        const next = await tx.customerAddress.findFirst({ where: { customerId }, orderBy: { createdAt: 'asc' } });
        if (next) await tx.customerAddress.update({ where: { id: next.id }, data: { isDefault: true } });
      }
      return removed;
    }),

  /** Applies the valid rows of an import plan atomically. Returns created/updated counts. */
  applyImport: (rows: CustomerImportRow[], toCreate: (r: CustomerImportRow) => Prisma.CustomerCreateInput, toUpdate: (r: CustomerImportRow) => Prisma.CustomerUpdateInput) =>
    prisma.$transaction(
      async (tx) => {
        let created = 0;
        let updated = 0;
        for (const row of rows) {
          if (row.errors.length > 0 || !row.input) continue;
          if (row.action === 'create') {
            await tx.customer.create({ data: toCreate(row) });
            created++;
          } else if (row.existingId) {
            await tx.customer.update({ where: { id: row.existingId }, data: toUpdate(row) });
            const address = row.input.addresses[0];
            if (address) {
              const count = await tx.customerAddress.count({ where: { customerId: row.existingId } });
              if (count === 0) await tx.customerAddress.create({ data: { ...address, isDefault: true, customerId: row.existingId } });
            }
            updated++;
          }
        }
        return { created, updated };
      },
      { timeout: 120_000 },
    ),
};
