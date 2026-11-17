// Development-only seed. Creates one admin staff user from SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD if that email is
// unused; an existing account keeps its password, role and active flag unless --reset-admin is given. With --samples
// (NODE_ENV=development only) it also inserts clearly fake products, mock inventory rows and one customer so the mock
// inventory adapter's behaviours (-OOS, -ERR, -NA) can be exercised.
//   npm run seed                      → admin only
//   npm run seed -- --samples
//   npm run seed -- --reset-admin     → also resets the existing admin's password, role and active flag
// Before any write (scripts/seed-guard.ts): refuses production, protected database identities
// (PROTECTED_DATABASE_IDENTITIES) and the integration-test database, prints the masked target and asks the operator
// to type its database name. Interactive terminal only.
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { checkSeedTarget, ensureStaffUser, seedConfirmed } from '../scripts/seed-guard.ts';

const samples = process.argv.includes('--samples');
const resetAdmin = process.argv.includes('--reset-admin');

const target = checkSeedTarget(process.env, { samples });
if (!target.ok) {
  console.error(`Refusing to seed: ${target.reason}. Nothing was written.`);
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

console.log(`Seed target: ${target.masked}`);
console.log(`Will write: admin account (create if missing${resetAdmin ? ', reset if present' : ''})${samples ? ', sample products, inventory, customer and staff accounts' : ''}.`);
if (!process.stdin.isTTY) {
  console.error('Refusing to seed: run it in an interactive terminal to confirm the target. Nothing was written.');
  process.exit(2);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const typed = await rl.question(`Type the database name (${target.database}) to write to it: `);
rl.close();
if (!seedConfirmed(typed, target.database)) {
  console.error('Not confirmed. Nothing was written.');
  process.exit(2);
}

// Loaded only now: nothing reaches the database before the target is checked and confirmed.
const { prisma } = await import('../src/config/db.ts');
const { hashPassword } = await import('../src/modules/auth/auth.tokens.ts');
const passwordHash = await hashPassword(password);
const admin = await ensureStaffUser(prisma, { email, passwordHash, name: 'Administrator', role: 'admin' }, { reset: resetAdmin });
console.log(`Admin user ${email}: ${admin === 'unchanged' ? 'already exists, left unchanged (use --reset-admin to reset it)' : admin}`);

if (samples) {
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
  // Created if missing; existing accounts are left unchanged.
  for (const [role, mail] of [['staff', 'staff@example.com'], ['approver', 'approver@example.com']] as const) {
    await ensureStaffUser(prisma, { email: mail, passwordHash, name: `Mock ${role}`, role });
  }
  console.log(`Sample data ready: ${products.length} mock products, mock inventory rows, 1 mock customer, staff@example.com + approver@example.com (seed password)`);
}

await prisma.$disconnect();
