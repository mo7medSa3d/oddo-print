DROP INDEX IF EXISTS "print_jobs_internal_idempotency_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "print_jobs_internal_idempotency_unique"
  ON "print_jobs" ("tenant_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL AND "api_key_id" IS NULL;
