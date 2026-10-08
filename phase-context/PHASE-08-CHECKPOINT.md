# Phase 08 — Queue claim fencing and HTTP poll

Status: SOURCE FIXED, PostgreSQL INTEGRATION VERIFIED, PHYSICAL DELIVERY UNVERIFIED.

Defect: GET /api/agent/jobs claimed up to 20 rows with DELIVERY_EVIDENCE_PENDING but truncated >64MiB HTTP response to fewer jobs. Unsent rows became unknown-outcome and could not safely auto-retry.

Fix in src/app/api/agent/jobs/route.ts: rank claimable candidates by intended priority and age, compute cumulative octet_length(payload::text)+2048, only UPDATE bounded candidates. Return all claimed rows. No blind retry, no weakened tenant/claim guards.

Native RED before / GREEN after regression. tests/ws-claim-delivery.test.ts 10 maximum-size jobs validates unsent row queued and later claimable; GitHub CI 37828492290 PostgreSQL 392 tests passed, including classified integration regression.

Remaining: physical Agent receive/ACK/printer output; network disconnect replay lab. Source: https://www.postgresql.org/docs/16/sql-select.html
