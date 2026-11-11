-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateEnum
CREATE TYPE "language" AS ENUM ('en', 'ml', 'ta', 'hi');

-- CreateEnum
CREATE TYPE "call_status" AS ENUM ('ringing', 'in_progress', 'completed', 'handed_over', 'failed');

-- CreateEnum
CREATE TYPE "speaker" AS ENUM ('customer', 'agent', 'system');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('draft', 'pending_approval', 'approved', 'rejected', 'cancelled', 'fulfilled');

-- CreateEnum
CREATE TYPE "order_item_status" AS ENUM ('confirmed', 'flagged', 'removed');

-- CreateEnum
CREATE TYPE "reservation_status" AS ENUM ('active', 'consumed', 'released', 'expired');

-- CreateEnum
CREATE TYPE "exception_type" AS ENUM ('unknown_customer', 'product_not_found', 'ambiguous_product', 'out_of_stock', 'low_confidence', 'customer_requested_human', 'call_dropped_with_draft', 'duplicate_suspected', 'reservation_expired', 'integration_failure');

-- CreateEnum
CREATE TYPE "exception_status" AS ENUM ('open', 'in_progress', 'resolved', 'dismissed');

-- CreateEnum
CREATE TYPE "approval_decision" AS ENUM ('approved', 'rejected', 'modified');

-- CreateEnum
CREATE TYPE "cost_service" AS ENUM ('telephony', 'stt', 'llm', 'tts');

-- CreateEnum
CREATE TYPE "staff_role" AS ENUM ('admin', 'supervisor', 'operator');

-- CreateEnum
CREATE TYPE "inventory_source" AS ENUM ('mock', 'client_api', 'manual');

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "external_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone_primary" TEXT NOT NULL,
    "phone_alternates" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "gstin" TEXT,
    "drug_license_no" TEXT,
    "address" TEXT,
    "preferred_language" "language" NOT NULL DEFAULT 'en',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "external_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "generic_name" TEXT,
    "strength" TEXT,
    "form" TEXT,
    "pack_size" TEXT NOT NULL,
    "manufacturer" TEXT,
    "mrp_paise" INTEGER,
    "ptr_paise" INTEGER,
    "gst_rate" DECIMAL(4,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "quantity_available" INTEGER NOT NULL,
    "quantity_reserved" INTEGER NOT NULL DEFAULT 0,
    "source" "inventory_source" NOT NULL,
    "synced_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" TEXT NOT NULL,
    "provider_call_sid" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'inbound',
    "from_number" TEXT NOT NULL,
    "to_number" TEXT NOT NULL,
    "customer_id" UUID,
    "status" "call_status" NOT NULL,
    "language" "language",
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "answered_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "duration_seconds" INTEGER,
    "recording_url" TEXT,
    "handover_reason" TEXT,
    "ai_summary" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcripts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "call_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "speaker" "speaker" NOT NULL,
    "text" TEXT NOT NULL,
    "language" "language",
    "confidence" DECIMAL(4,3),
    "offset_ms" INTEGER,
    "duration_ms" INTEGER,
    "tool_calls" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_number" TEXT NOT NULL,
    "call_id" UUID,
    "customer_id" UUID NOT NULL,
    "status" "order_status" NOT NULL,
    "idempotency_key" TEXT,
    "subtotal_paise" INTEGER NOT NULL DEFAULT 0,
    "tax_paise" INTEGER NOT NULL DEFAULT 0,
    "total_paise" INTEGER NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "created_by" TEXT NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" UUID,
    "requested_text" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_paise" INTEGER,
    "line_total_paise" INTEGER,
    "match_confidence" DECIMAL(4,3),
    "confirmed_by_customer" BOOLEAN NOT NULL DEFAULT false,
    "status" "order_item_status" NOT NULL,
    "flag_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_reservations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_item_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "reservation_status" NOT NULL,
    "external_reservation_ref" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "released_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exceptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "exception_type" NOT NULL,
    "status" "exception_status" NOT NULL DEFAULT 'open',
    "call_id" UUID,
    "order_id" UUID,
    "order_item_id" UUID,
    "description" TEXT NOT NULL,
    "assigned_to" UUID,
    "resolution_note" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "staff_user_id" UUID NOT NULL,
    "decision" "approval_decision" NOT NULL,
    "from_status" "order_status" NOT NULL,
    "to_status" "order_status" NOT NULL,
    "note" TEXT,
    "changes" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_costs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "call_id" UUID NOT NULL,
    "service" "cost_service" NOT NULL,
    "provider" TEXT NOT NULL,
    "units" DECIMAL(12,3) NOT NULL,
    "unit_type" TEXT NOT NULL,
    "cost_micro_usd" BIGINT NOT NULL,
    "cost_paise" INTEGER,
    "fx_rate" DECIMAL(10,4),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" CITEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "staff_role" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "staff_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip" INET,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_external_code_key" ON "customers"("external_code");

-- CreateIndex
CREATE UNIQUE INDEX "customers_phone_primary_key" ON "customers"("phone_primary");

-- CreateIndex
CREATE INDEX "customers_phone_alternates_idx" ON "customers" USING GIN ("phone_alternates");

-- CreateIndex
CREATE UNIQUE INDEX "products_external_code_key" ON "products"("external_code");

-- CreateIndex
CREATE INDEX "products_name_idx" ON "products" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "products_generic_name_idx" ON "products" USING GIN ("generic_name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "products_is_active_idx" ON "products"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_product_id_key" ON "inventory"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "calls_provider_call_sid_key" ON "calls"("provider_call_sid");

-- CreateIndex
CREATE INDEX "calls_customer_id_idx" ON "calls"("customer_id");

-- CreateIndex
CREATE INDEX "calls_started_at_idx" ON "calls"("started_at" DESC);

-- CreateIndex
CREATE INDEX "calls_status_idx" ON "calls"("status");

-- CreateIndex
CREATE UNIQUE INDEX "transcripts_call_id_sequence_key" ON "transcripts"("call_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE UNIQUE INDEX "orders_call_id_key" ON "orders"("call_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_idempotency_key_key" ON "orders"("idempotency_key");

-- CreateIndex
CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at");

-- CreateIndex
CREATE INDEX "orders_customer_id_created_at_idx" ON "orders"("customer_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "order_items_order_id_line_no_key" ON "order_items"("order_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "stock_reservations_order_item_id_key" ON "stock_reservations"("order_item_id");

-- CreateIndex
CREATE INDEX "stock_reservations_product_id_status_idx" ON "stock_reservations"("product_id", "status");

-- CreateIndex
CREATE INDEX "stock_reservations_status_expires_at_idx" ON "stock_reservations"("status", "expires_at");

-- CreateIndex
CREATE INDEX "exceptions_status_created_at_idx" ON "exceptions"("status", "created_at");

-- CreateIndex
CREATE INDEX "exceptions_call_id_idx" ON "exceptions"("call_id");

-- CreateIndex
CREATE INDEX "exceptions_order_id_idx" ON "exceptions"("order_id");

-- CreateIndex
CREATE INDEX "staff_approvals_order_id_created_at_idx" ON "staff_approvals"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "usage_costs_call_id_idx" ON "usage_costs"("call_id");

-- CreateIndex
CREATE INDEX "usage_costs_created_at_idx" ON "usage_costs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "staff_users_email_key" ON "staff_users"("email");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_created_at_idx" ON "audit_logs"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- AddForeignKey
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_approvals" ADD CONSTRAINT "staff_approvals_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_approvals" ADD CONSTRAINT "staff_approvals_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_costs" ADD CONSTRAINT "usage_costs_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- CHECK constraints not expressible in the Prisma schema (ARCHITECTURE.md §D.3).
-- Prisma Migrate does not track CHECK constraints, so these never cause drift.
-- ---------------------------------------------------------------------------
ALTER TABLE "inventory"
  ADD CONSTRAINT "inventory_quantity_available_nonneg" CHECK ("quantity_available" >= 0),
  ADD CONSTRAINT "inventory_quantity_reserved_range"  CHECK ("quantity_reserved" >= 0 AND "quantity_reserved" <= "quantity_available");

ALTER TABLE "products"
  ADD CONSTRAINT "products_prices_nonneg" CHECK (("mrp_paise" IS NULL OR "mrp_paise" >= 0) AND ("ptr_paise" IS NULL OR "ptr_paise" >= 0));

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_quantity_positive"         CHECK ("quantity" > 0),
  ADD CONSTRAINT "order_items_confirmed_requires_product" CHECK ("status" <> 'confirmed' OR ("product_id" IS NOT NULL AND "confirmed_by_customer"));

ALTER TABLE "stock_reservations"
  ADD CONSTRAINT "stock_reservations_quantity_positive" CHECK ("quantity" > 0);
