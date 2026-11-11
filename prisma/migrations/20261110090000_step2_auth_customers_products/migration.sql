-- Build step 2: staff authentication, customer management, product catalogue.
-- * staff_role enum: admin/supervisor/operator -> admin/staff/approver
-- * customers: is_active -> status (customer_status); + email; address column replaced by customer_addresses table
-- * products:  is_active -> status (product_status); + brand; + unit
-- * refresh_tokens table (SHA-256 token hashes, rotation chain via replaced_by_id)
-- * audit_logs.entity_id nullable (events without a persisted entity, e.g. failed login for unknown email)
-- Non-destructive on an empty database. If 20261109120000_init was applied with data, map is_active -> status
-- and copy customers.address into customer_addresses manually before applying this migration.

-- CreateEnum
CREATE TYPE "customer_status" AS ENUM ('active', 'inactive', 'blocked');

-- CreateEnum
CREATE TYPE "product_status" AS ENUM ('active', 'inactive', 'discontinued');

-- AlterEnum
BEGIN;
CREATE TYPE "staff_role_new" AS ENUM ('admin', 'staff', 'approver');
ALTER TABLE "staff_users" ALTER COLUMN "role" TYPE "staff_role_new" USING ("role"::text::"staff_role_new");
ALTER TYPE "staff_role" RENAME TO "staff_role_old";
ALTER TYPE "staff_role_new" RENAME TO "staff_role";
DROP TYPE "staff_role_old";
COMMIT;

-- DropIndex
DROP INDEX "products_is_active_idx";

-- AlterTable
ALTER TABLE "customers" DROP COLUMN "address",
DROP COLUMN "is_active",
ADD COLUMN     "email" TEXT,
ADD COLUMN     "status" "customer_status" NOT NULL DEFAULT 'active';

-- AlterTable
ALTER TABLE "products" DROP COLUMN "is_active",
ADD COLUMN     "brand" TEXT,
ADD COLUMN     "status" "product_status" NOT NULL DEFAULT 'active',
ADD COLUMN     "unit" TEXT;

-- AlterTable
ALTER TABLE "audit_logs" ALTER COLUMN "entity_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "customer_addresses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Default',
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "pincode" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "replaced_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_addresses_customer_id_idx" ON "customer_addresses"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "customers_status_idx" ON "customers"("status");

-- CreateIndex
CREATE INDEX "products_brand_idx" ON "products"("brand");

-- CreateIndex
CREATE INDEX "products_status_idx" ON "products"("status");

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "staff_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

