-- 0076: actually apply the discovery candidate_status domain that 0075 intended.
--
-- 0075 wrapped its ADD CONSTRAINT in
--   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discovered_devices_candidate_status_check')
-- but 0010 (inline) / 0014 / 0025 already create that constraint with the
-- 5-value domain ('discovered','verified','provisioned','ignored','expired').
-- The guard was therefore always satisfied and the 3-value ADD never ran, so
-- the database kept admitting two values that neither the application state
-- machine nor src/db/schema.ts (candidateStatusCheck) nor
-- DISCOVERY_CANDIDATE_STATUS in src/lib/discovery.ts declares.
--
-- 'ignored' and 'expired' are unreachable from every writer in this
-- repository: the agent report route always writes 'discovered'
-- (src/app/api/agent/discovery/route.ts), the verify route only advances
-- candidate_status = 'discovered' -> 'verified', and the provision route only
-- advances 'verified' -> 'provisioned'. A row that somehow holds one of the
-- retired values is permanently unusable: verify gates on
-- eq(candidateStatus, "discovered") and provision gates on
-- candidateStatus === "verified", so it can never be approved or provisioned
-- again and only an out-of-band UPDATE can recover it. Normalizing such rows
-- back to 'discovered' is therefore lossless in behaviour (it returns the row
-- to the state every fresh discovery report already produces) and lets the
-- intended CHECK be enforced.
--
-- The DROP/ADD is deliberately NOT wrapped in an existence guard: a guarded
-- statement is exactly what made 0075 a silent no-op. The ADD is the
-- authoritative statement for this constraint name, and re-running the file is
-- safe because the DROP precedes it.
--
-- The existence probe is scoped with current_schema() (the pattern introduced
-- in 0011 and used by 0025) so a worker-schema replay cannot be suppressed by
-- the same-named constraint in `public`.
-->
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'discovered_devices'
  ) THEN
    UPDATE discovered_devices
       SET candidate_status = 'discovered'
     WHERE candidate_status NOT IN ('discovered', 'verified', 'provisioned');

    ALTER TABLE discovered_devices DROP CONSTRAINT IF EXISTS discovered_devices_candidate_status_check;
    ALTER TABLE discovered_devices
      ADD CONSTRAINT discovered_devices_candidate_status_check
      CHECK (candidate_status IN ('discovered', 'verified', 'provisioned'));
  END IF;
END $$;