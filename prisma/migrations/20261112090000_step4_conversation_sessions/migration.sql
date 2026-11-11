-- Build step 4: AI conversation engine.
-- * conversation_state enum; calls.conversation_state (+ index) and calls.last_activity_at — the call row is the conversation session
-- * call_events table: state changes, tool executions, handovers, provider errors (transcript text stays in transcripts)
-- * orders.delivery_address_id -> customer_addresses (delivery location confirmed during the call)
-- Additive only; safe on populated databases.

-- CreateEnum
CREATE TYPE "conversation_state" AS ENUM ('initializing', 'identifying_customer', 'confirming_location', 'collecting_items', 'matching_products', 'checking_inventory', 'reviewing_shortages', 'building_order', 'reading_back', 'waiting_customer_confirmation', 'handover_required', 'completed', 'failed');

-- AlterTable
ALTER TABLE "calls" ADD COLUMN     "conversation_state" "conversation_state" NOT NULL DEFAULT 'initializing',
ADD COLUMN     "last_activity_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "delivery_address_id" UUID;

-- CreateTable
CREATE TABLE "call_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "call_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "from_state" "conversation_state",
    "to_state" "conversation_state",
    "tool_name" TEXT,
    "tool_call_id" TEXT,
    "ok" BOOLEAN,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "call_events_call_id_created_at_idx" ON "call_events"("call_id", "created_at");

-- CreateIndex
CREATE INDEX "call_events_type_idx" ON "call_events"("type");

-- CreateIndex
CREATE INDEX "calls_conversation_state_idx" ON "calls"("conversation_state");

-- AddForeignKey
ALTER TABLE "call_events" ADD CONSTRAINT "call_events_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_delivery_address_id_fkey" FOREIGN KEY ("delivery_address_id") REFERENCES "customer_addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

