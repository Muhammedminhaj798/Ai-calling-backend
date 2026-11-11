// Development-only seed. Creates (or resets) one admin staff user from SEED_ADMIN_EMAIL and
// SEED_ADMIN_PASSWORD. With --samples it also inserts clearly fake products, mock inventory rows
// and one customer so the mock inventory adapter's behaviours (-OOS, -ERR, -NA) can be exercised.
//   npm run seed            → admin only
//   npm run seed -- --samples
import 'dotenv/config';
import { z } from 'zod';
import { prisma } from '../src/config/db.ts';
import { hashPassword } from '../src/modules/auth/auth.tokens.ts';

if (process.env['NODE_ENV'] === 'production') {
  console.error('Refusing to run the development seed with NODE_ENV=production');
  process.exit(1);
}

const seedEnv = z
  .object({
    SEED_ADMIN_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
    SEED_ADMIN_PASSWORD: z.string().min(12, 'at least 12 characters'),
  })
  .safeParse(process.env);

if (!seedEnv.success) {
  console.error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (min 12 characters) in the environment or .env:\n' + z.prettifyError(seedEnv.error));
  process.exit(1);
}

const { SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: password } = seedEnv.data;
const passwordHash = await hashPassword(password);
const admin = await prisma.staffUser.upsert({
  where: { email },
  update: { passwordHash, role: 'admin', isActive: true },
  create: { email, passwordHash, name: 'Administrator', role: 'admin' },
});
console.log(`Admin user ready: ${admin.email} (${admin.id})`);

if (process.argv.includes('--samples')) {
  const products = [
    { externalCode: 'MOCK-PARA-650', name: 'Mockamol 650', brand: 'Mockamol', genericName: 'Paracetamol', strength: '650 mg', form: 'tablet', packSize: '15x10', unit: 'strip', manufacturer: 'Mock Pharma Ltd', mrpPaise: 3200, ptrPaise: 2560, stock: 1200 },
    { externalCode: 'MOCK-AMOX-500-OOS', name: 'Mockxicillin 500', brand: 'Mockxicillin', genericName: 'Amoxicillin', strength: '500 mg', form: 'capsule', packSize: '10x10', unit: 'strip', manufacturer: 'Mock Pharma Ltd', mrpPaise: 9800, ptrPaise: 7840, stock: 0 },
    { externalCode: 'MOCK-CETZ-10-ERR', name: 'Mockzine 10', brand: 'Mockzine', genericName: 'Cetirizine', strength: '10 mg', form: 'tablet', packSize: '10x10', unit: 'strip', manufacturer: 'Sample Labs', mrpPaise: 2500, ptrPaise: 2000, stock: 300 },
    { externalCode: 'MOCK-ORS-200-NA', name: 'Mocklyte ORS', brand: 'Mocklyte', genericName: 'Oral rehydration salts', strength: null, form: 'powder', packSize: '21 g sachet', unit: 'sachet', manufacturer: 'Sample Labs', mrpPaise: 2100, ptrPaise: 1700, stock: null },
  ];
  for (const { stock, ...p } of products) {
    const product = await prisma.product.upsert({ where: { externalCode: p.externalCode }, update: p, create: p });
    if (stock !== null) {
      await prisma.inventory.upsert({
        where: { productId: product.id },
        update: { quantityAvailable: stock, source: 'mock', syncedAt: new Date() },
        create: { productId: product.id, quantityAvailable: stock, source: 'mock', syncedAt: new Date() },
      });
    }
  }
  await prisma.customer.upsert({
    where: { externalCode: 'MOCK-CUST-001' },
    update: {},
    create: {
      externalCode: 'MOCK-CUST-001',
      name: 'Sample Medicals (mock)',
      phonePrimary: '+919000000001',
      preferredLanguage: 'ml',
      addresses: { create: [{ label: 'Shop', line1: '1 Sample Street', city: 'Kochi', state: 'Kerala', pincode: '682001', isDefault: true }] },
    },
  });
  // Two more mock staff accounts (same seed password) so the dashboard's role-based UI can be exercised.
  for (const [role, mail] of [['staff', 'staff@example.com'], ['approver', 'approver@example.com']] as const) {
    await prisma.staffUser.upsert({ where: { email: mail }, update: { passwordHash, role, isActive: true }, create: { email: mail, passwordHash, name: `Mock ${role}`, role } });
  }
  console.log(`Sample data ready: ${products.length} mock products, mock inventory rows, 1 mock customer, staff@example.com + approver@example.com (seed password)`);
}

await prisma.$disconnect();
