-- Print-job lifetime timestamps move from `now()` to `clock_timestamp()`.
--
-- PostgreSQL `now()` returns the *transaction start* timestamp. The Gateway
-- enqueue transaction takes advisory locks and performs several reads before the
-- INSERT, so a job could be persisted with a `created_at` older than the
-- `clock_timestamp()` reading the same transaction used for `expires_at`
-- (default TTL, caller-supplied TTL, and the 24 hour cap are all validated
-- against it). The per-minute rate window in `enforceTenantJobEntitlements`
-- (`created_at >= now() - interval '1 minute'`) and the maintenance sweeps read
-- the same column, so the disagreement was observable as an undercounted print
-- rate.
--
-- The Gateway now stamps both columns explicitly from the clock read it already
-- performs; these defaults keep every other writer (migrations, operational
-- scripts, tests) on the same wall clock. Explicit INSERT/UPDATE values, such as
-- an `updated_at = now()` claim write, are unaffected.
ALTER TABLE "print_jobs" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();
ALTER TABLE "print_jobs" ALTER COLUMN "updated_at" SET DEFAULT clock_timestamp();
