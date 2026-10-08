# Phase 26 — Bounded recovery/retention sweeps

Status: SOURCE FIXED; FULL CRASH/RESTORE/DR VERIFICATION BLOCKED.

Defect: MAINTENANCE_SWEEP_LIMIT=0.5 or JOB_RETENTION_SWEEP_LIMIT=0.5 yielded LIMIT 0 and silently skipped recovery/retention, while huge maintenance env override allowed excessive row lock batches.

Fix in src/lib/job-maintenance.ts: require a finite value >=1, floor and clamp at 5000; defaults 200 maintenance and 500 retention unchanged. tests/sweep-limit.regression.test.mjs: old expressions RED / new expressions 4/4 GREEN. Full Node 133/133 pass.

Remaining: live PG interruption, backup/restore, multi-node reconnection and physical printing ambiguity checks. Do not auto retry unknown physical outcomes.
