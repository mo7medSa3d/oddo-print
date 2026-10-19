-- Consolidate the print_jobs API-key index.
--
-- Every apiKeyId lookup in the console/agent codepaths is ALSO tenant-scoped
-- (`WHERE tenant_id = $1 AND api_key_id = $2`), so a composite (tenant_id,
-- api_key_id) index fully serves them. Replacing the legacy single-column
-- api_key_id index with the composite avoids a second btree that never wins
-- the planner and only costs write time. DROP is safe to replay (IF EXISTS),
-- and CREATE IF NOT EXISTS keeps this idempotent like the earlier index
-- migrations.

DROP INDEX IF EXISTS "print_jobs_api_key_id_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_jobs_tenant_api_key_idx"
  ON "print_jobs" USING btree ("tenant_id", "api_key_id");
