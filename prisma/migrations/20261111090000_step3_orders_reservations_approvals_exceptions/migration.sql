-- Build step 3: order management, customer confirmation, stock reservations, staff approvals, exceptions.
-- * order_status enum: draft, pending_customer_confirmation, customer_confirmed, pending_stock_reservation,
--   pending_staff_approval, approved, rejected, cancelled, failed, fulfilled (pending_approval removed)
-- * order_item_status enum: active | flagged (confirmed/removed removed); confirmed_by_customer -> customer_decision
-- * order_items: catalogue snapshot columns, stock_status/stock_checked_at/available_at_check
-- * orders: revision, customer_po_reference, reserve_idempotency_key, customer_confirmed_at
-- * new tables: order_events (history), order_confirmations (read-back + customer confirmation)
-- * stock_reservations: order_id, provider, idempotency_key; order_item_id no longer unique (history kept)
-- * exceptions: customer_id, details, resolved_by_id; exception_type enum aligned with the step-3 brief
-- * sequence order_number_seq for human-readable order numbers
-- Non-destructive on an empty database. If step-2 data exists, map order statuses manually first.

-- The old CHECK references 'confirmed', which the new enum no longer has; drop it before the enum is altered.
ALTER TABLE "order_items" DROP CONSTRAINT IF EXISTS "order_items_confirmed_requires_product";

-- CreateEnum
CREATE TYPE "item_stock_status" AS ENUM ('unchecked', 'in_stock', 'insufficient', 'out_of_stock', 'unknown', 'error');

-- CreateEnum
CREATE TYPE "customer_decision" AS ENUM ('pending', 'accepted', 'declined');

-- CreateEnum
CREATE TYPE "confirmation_status" AS ENUM ('pending', 'confirmed', 'superseded');

-- CreateEnum
CREATE TYPE "confirmation_source" AS ENUM ('phone_ai', 'phone_staff', 'manual');

-- AlterEnum
BEGIN;
CREATE TYPE "order_status_new" AS ENUM ('draft', 'pending_customer_confirmation', 'customer_confirmed', 'pending_stock_reservation', 'pending_staff_approval', 'approved', 'rejected', 'cancelled', 'failed', 'fulfilled');
ALTER TABLE "orders" ALTER COLUMN "status" TYPE "order_status_new" USING ("status"::text::"order_status_new");
ALTER TABLE "staff_approvals" ALTER COLUMN "from_status" TYPE "order_status_new" USING ("from_status"::text::"order_status_new");
ALTER TABLE "staff_approvals" ALTER COLUMN "to_status" TYPE "order_status_new" USING ("to_status"::text::"order_status_new");
ALTER TYPE "order_status" RENAME TO "order_status_old";
ALTER TYPE "order_status_new" RENAME TO "order_status";
DROP TYPE "order_status_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "order_item_status_new" AS ENUM ('active', 'flagged');
ALTER TABLE "order_items" ALTER COLUMN "status" TYPE "order_item_status_new" USING ("status"::text::"order_item_status_new");
ALTER TYPE "order_item_status" RENAME TO "order_item_status_old";
ALTER TYPE "order_item_status_new" RENAME TO "order_item_status";
DROP TYPE "order_item_status_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "exception_type_new" AS ENUM ('product_not_found', 'ambiguous_product', 'insufficient_stock', 'out_of_stock', 'inventory_api_error', 'customer_not_registered', 'customer_not_eligible', 'reservation_failed', 'reservation_expired', 'customer_unconfirmed', 'order_validation_failed', 'human_handover_required', 'low_confidence', 'call_dropped_with_draft', 'duplicate_suspected');
ALTER TABLE "exceptions" ALTER COLUMN "type" TYPE "exception_type_new" USING ("type"::text::"exception_type_new");
ALTER TYPE "exception_type" RENAME TO "exception_type_old";
ALTER TYPE "exception_type_new" RENAME TO "exception_type";
DROP TYPE "exception_type_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "stock_reservations" DROP CONSTRAINT "stock_reservations_order_item_id_fkey";

-- DropIndex
DROP INDEX "stock_reservations_order_item_id_key";

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "customer_confirmed_at" TIMESTAMPTZ(6),
ADD COLUMN     "customer_po_reference" TEXT,
ADD COLUMN     "reserve_idempotency_key" TEXT,
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "status" SET DEFAULT 'draft';

-- AlterTable
ALTER TABLE "order_items" DROP COLUMN "confirmed_by_customer",
ADD COLUMN     "available_at_check" INTEGER,
ADD COLUMN     "brand_snapshot" TEXT,
ADD COLUMN     "customer_decision" "customer_decision" NOT NULL DEFAULT 'pending',
ADD COLUMN     "form_snapshot" TEXT,
ADD COLUMN     "name_snapshot" TEXT,
ADD COLUMN     "pack_size_snapshot" TEXT,
ADD COLUMN     "stock_checked_at" TIMESTAMPTZ(6),
ADD COLUMN     "stock_status" "item_stock_status" NOT NULL DEFAULT 'unchecked',
ADD COLUMN     "strength_snapshot" TEXT,
ADD COLUMN     "unit_snapshot" TEXT,
ALTER COLUMN "status" SET DEFAULT 'active';

-- AlterTable
ALTER TABLE "stock_reservations" ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "order_id" UUID NOT NULL,
ADD COLUMN     "provider" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "exceptions" ADD COLUMN     "customer_id" UUID,
ADD COLUMN     "details" JSONB,
ADD COLUMN     "resolved_by_id" UUID;

-- CreateTable
CREATE TABLE "order_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "from_status" "order_status",
    "to_status" "order_status",
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "reason" TEXT,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_confirmations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "confirmation_status" NOT NULL DEFAULT 'pending',
    "items_snapshot" JSONB NOT NULL,
    "readback_text" TEXT NOT NULL,
    "readback_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "confirmation_source",
    "confirmed_at" TIMESTAMPTZ(6),
    "idempotency_key" TEXT,
    "actor_type" TEXT,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_events_order_id_created_at_idx" ON "order_events"("order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "order_confirmations_idempotency_key_key" ON "order_confirmations"("idempotency_key");

-- CreateIndex
CREATE INDEX "order_confirmations_order_id_revision_idx" ON "order_confirmations"("order_id", "revision");

-- CreateIndex
CREATE INDEX "stock_reservations_order_id_status_idx" ON "stock_reservations"("order_id", "status");

-- CreateIndex
CREATE INDEX "stock_reservations_order_item_id_idx" ON "stock_reservations"("order_item_id");

-- CreateIndex
CREATE INDEX "exceptions_type_status_idx" ON "exceptions"("type", "status");

-- CreateIndex
CREATE INDEX "exceptions_customer_id_idx" ON "exceptions"("customer_id");

-- CreateIndex
CREATE INDEX "exceptions_assigned_to_status_idx" ON "exceptions"("assigned_to", "status");

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_confirmations" ADD CONSTRAINT "order_confirmations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Not expressible in the Prisma schema
-- ---------------------------------------------------------------------------
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_active_requires_product" CHECK ("status" <> 'active' OR "product_id" IS NOT NULL);

CREATE SEQUENCE IF NOT EXISTS "order_number_seq" START WITH 1 INCREMENT BY 1;
