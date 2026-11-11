// Prisma queries for calls (conversation sessions), transcripts, call events and usage costs.
import { prisma } from '../../config/db.ts';
import type { Prisma } from '../../generated/prisma/client.ts';

export const callDetailInclude = {
  customer: { select: { id: true, externalCode: true, name: true, phonePrimary: true, status: true, preferredLanguage: true } },
  order: { select: { id: true, orderNumber: true, status: true, revision: true, totalPaise: true, deliveryAddressId: true } },
  exceptions: { where: { status: { in: ['open', 'in_progress'] } }, select: { id: true, type: true, status: true, description: true } },
  _count: { select: { transcripts: true, events: true } },
} satisfies Prisma.CallInclude;

export type CallDetailRecord = Prisma.CallGetPayload<{ include: typeof callDetailInclude }>;

const listInclude = {
  customer: { select: { id: true, externalCode: true, name: true } },
  order: { select: { id: true, orderNumber: true, status: true } },
} satisfies Prisma.CallInclude;

export const callsRepository = {
  create: (data: Prisma.CallUncheckedCreateInput) => prisma.call.create({ data, include: callDetailInclude }),
  findById: (id: string) => prisma.call.findUnique({ where: { id }, include: callDetailInclude }),
  findByProviderSid: (providerCallSid: string) => prisma.call.findUnique({ where: { providerCallSid }, include: callDetailInclude }),
  update: (id: string, data: Prisma.CallUncheckedUpdateInput) => prisma.call.update({ where: { id }, data }),
  list(where: Prisma.CallWhereInput, orderBy: Prisma.CallOrderByWithRelationInput, skip: number, take: number) {
    return Promise.all([prisma.call.findMany({ where, orderBy, skip, take, include: listInclude }), prisma.call.count({ where })]);
  },

  async addTranscript(callId: string, entry: Prisma.TranscriptUncheckedCreateInput) {
    const agg = await prisma.transcript.aggregate({ where: { callId }, _max: { sequence: true } });
    return prisma.transcript.create({ data: { ...entry, callId, sequence: (agg._max.sequence ?? 0) + 1 } });
  },
  transcripts: (callId: string) => prisma.transcript.findMany({ where: { callId }, orderBy: { sequence: 'asc' } }),

  addEvent: (data: Prisma.CallEventUncheckedCreateInput) => prisma.callEvent.create({ data }),
  events: (callId: string, type: string | undefined, take: number) =>
    prisma.callEvent.findMany({ where: { callId, ...(type ? { type } : {}) }, orderBy: { createdAt: 'asc' }, take }),

  addUsage: (rows: Prisma.UsageCostUncheckedCreateInput[]) => prisma.usageCost.createMany({ data: rows }),
};
