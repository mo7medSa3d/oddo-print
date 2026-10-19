-- Enforce single Platform Owner invariant at database level
CREATE UNIQUE INDEX IF NOT EXISTS "users_single_platform_owner_idx" ON "users" ("is_platform_owner") WHERE "is_platform_owner" = true;
