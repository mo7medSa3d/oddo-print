-- Forward synchronization of offline audit repairs, maintenance indexes, and tenant fences.
-- All operations are forward-only, idempotent (IF NOT EXISTS), and safe for both fresh and upgraded databases.

ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "stripe_price_history" text[] NOT NULL DEFAULT ARRAY[]::text[];
--> statement-breakpoint
UPDATE "plans" SET "stripe_price_history" = ARRAY["stripe_price_id"] WHERE "stripe_price_id" IS NOT NULL AND "stripe_price_history" = ARRAY[]::text[];
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD COLUMN IF NOT EXISTS "stripe_state_revision" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD COLUMN IF NOT EXISTS "checkout_request_params" jsonb;
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD COLUMN IF NOT EXISTS "checkout_intent_created_at" timestamp;
--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "closed_claim_token_hash" text;
--> statement-breakpoint
ALTER TABLE "print_jobs" DROP CONSTRAINT IF EXISTS "print_jobs_payload_contract_check";
--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_payload_contract_check" CHECK (
  jsonb_typeof(payload) = 'object' AND (
    (COALESCE(payload->>'type', '') = 'raw' AND COALESCE(payload->>'protocol', '') IN ('raw','escpos','zpl','tspl'))
    OR (COALESCE(payload->>'type', '') = 'escpos' AND COALESCE(payload->>'protocol', '') = 'escpos')
    OR (COALESCE(payload->>'type', '') = 'pdf' AND COALESCE(payload->>'protocol', '') = '')
    OR (COALESCE(payload->>'type', '') = 'image' AND COALESCE(payload->>'protocol', '') = '')
  )
) NOT VALID;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_job_receipts" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "idempotency_key" text,
  "fingerprint" text NOT NULL,
  "printer_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "api_key_id" text,
  "destination" text,
  "document_type" text,
  "requested_by" text,
  "status" text NOT NULL CHECK ("status" IN ('success','failed','expired')),
  "error" text,
  "closed_claim_token_hash" text,
  "delivered_at" timestamp,
  "acked_at" timestamp,
  "created_at" timestamp NOT NULL,
  "updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "print_job_receipts_tenant_idempotency_unique" ON "print_job_receipts"("tenant_id", "idempotency_key");
--> statement-breakpoint
ALTER TABLE "print_job_receipts" ALTER COLUMN "requested_by" DROP NOT NULL;
--> statement-breakpoint
-- AUDIT-02: Maintenance sweep and retention index for status + updated_at
CREATE INDEX IF NOT EXISTS "print_jobs_status_updated_idx" ON "print_jobs" USING btree ("status", "updated_at");
--> statement-breakpoint
-- AUDIT-03: Foreign key cascade indexes
CREATE INDEX IF NOT EXISTS "refresh_tokens_tenant_idx" ON "refresh_tokens" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_invitations_inviter_user_idx" ON "tenant_invitations" USING btree ("inviter_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovered_devices_tenant_printer_idx" ON "discovered_devices" USING btree ("tenant_id", "provisioned_printer_id");
--> statement-breakpoint
-- AUDIT-05: Enforce tenantId in agent job availability notification trigger
CREATE OR REPLACE FUNCTION notify_agent_job_available()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.status = 'queued' AND OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM pg_notify(
      'print_gateway_agent_jobs',
      json_build_object('jobId', NEW.id, 'agentId', NEW.agent_id, 'tenantId', NEW.tenant_id)::text
    );
  END IF;
  RETURN NEW;
END;
$$;
