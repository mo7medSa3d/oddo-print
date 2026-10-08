# Phase 24 — Queue capacity and noisy-neighbor budgeting

Status: SOURCE FIXED, PG16 TEST VERIFIED, HIGH-SCALE BENCHMARK BLOCKED.

Defect: per-agent 128MiB queued payload ceiling previously summed pg_column_size(payload), a TOAST-compressed storage quantity, but incoming job was charged by JSON string bytes. Compressible jobs could exhaust agent runtime memory despite passing quota.

Fix in src/lib/print-job-service.ts: use SUM(octet_length(payload::text)) over unexpired queued rows under existing transaction agent lock. Add native and tests/queue-payload-budget.test.ts PG test for 19x 5MiB + rejected 20th, register in vitest.test-groups.mts. CI 392 PG integration tests passed. Repetitive payload uses valid canonical base64 with padding.

Outstanding: real 100/1k/10k-tenant load, measured p50/p95/p99, query planner evaluation. Docs: https://www.postgresql.org/docs/16/storage-toast.html
