DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM print_jobs
    WHERE idempotency_key IS NOT NULL
    GROUP BY tenant_id, idempotency_key
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'cannot enforce tenant-scoped print idempotency: duplicate tenant/idempotency_key rows already exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM tenant_users
    WHERE role = 'owner'
    GROUP BY tenant_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'cannot enforce single tenant owner: duplicate owner memberships already exist';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "print_jobs_tenant_idempotency_unique"
  ON "print_jobs" ("tenant_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

DROP INDEX IF EXISTS "print_jobs_idempotency_unique";
DROP INDEX IF EXISTS "print_jobs_internal_idempotency_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_users_single_owner_idx"
  ON "tenant_users" ("tenant_id")
  WHERE "role" = 'owner';
