# Operational acceptance and recovery

## Measured changes

Gateway's PostgreSQL pool now sets a 30-second `idle_in_transaction_session_timeout` in addition to the existing 30-second statement timeout and 5-second lock timeout. A real integration regression holds an advisory transaction lock, waits for PostgreSQL to terminate the stalled transaction, verifies the lock becomes available and verifies a replacement pool connection. Each newly created client has one lifetime error listener, so a checked-out client closed by the server cannot crash Node through an unhandled EventEmitter error. The listener is not added again on every checkout.

Graceful shutdown first rejects new HTTP work, sends WebSocket close code 1001, awaits completion of WebSocket close hooks, drains ordinary HTTP requests, awaits Next's `after()`/`waitUntil` close hook and tracked maintenance tasks, then ends the database pool. The application hard deadline is 45 seconds and Compose grants 60 seconds before forcing termination, covering the mail delivery service's three bounded ten-second attempts and one-/two-second retry waits. A real six-socket regression reproduced writes racing `pool.end()` before this change and passes after it; multi-instance delivery tests remain part of the same integration suite. A source-extracted asynchronous shutdown regression verifies delayed Next work completes before pool closure and that a failed Next cleanup produces a failing exit.

## Synthetic sustained Gateway check

Build the Gateway, provide a newly created loopback PostgreSQL role with `CREATEDB` privileges, then run:

```sh
DATABASE_URL="$SYNTHETIC_DATABASE_URL" \
  node --import tsx scripts/acceptance/gateway-soak.mjs /absolute/new/soak-evidence
```

The script creates and later drops a uniquely named synthetic database. It runs the actual production custom server and compiled routes behind a test HTTPS proxy, validates a generated private CA, and connects six authenticated consumers across three tenants. Those consumers have no printer backend: they acknowledge receipt and report a known pre-execution `failed/not_printed` result. Data is synthetic and no email/payment provider is configured.

For the production-role acceptance mode, supply a **new dedicated disposable
cluster** and its bootstrap URL, set `YASEIR_FRESH_ROLE_CLUSTER=1` and
`YASEIR_SOAK_DEDICATED_ROLE_PROFILE=1`. The harness applies the actual role profile,
migrates as owner and verifies runtime privileges. Only the restricted runtime
URL/password reaches the Gateway child; administrator/owner secret settings are
removed. It drops the new database and roles during cleanup. The caller owns
cluster startup/teardown and must record both; never use these flags with an
existing shared or real cluster.

Default load is 60 seconds of warmup and three continuous five-minute windows, with a prescribed maximum of two new jobs/second, one exact replay per job and a status read every ten jobs. The current valid-document corpus is 50% RAW receipts, 30% JPEG receipts, 15% ordinary PDF documents, 4% long JPEG receipts and 1% image-rich PDFs. `payload-corpus.json` records actual encoded/decoded sizes, hashes and compression ratios; there are no fixed-size placeholder payloads. Synthetic geometry profiles cover 58/80 mm paper and 203/300/600 DPI. Each delivered document's bytes, type, protocol and geometry binding are verified before its synthetic pre-execution outcome. Each agent maintains heartbeat, WebSocket reconnect and polling fallback paths. Existing entitlement limits remain enabled. After the memory measurement, eight additional jobs per agent are deliberately left queued, the Gateway restarts, all six agents drain their durable jobs, and operation/status identities are checked again.

Resource evidence includes per-second RSS, used/total heap, V8 heap spaces, external/ArrayBuffer memory, GC counts/duration, event-loop delay, CPU, file descriptors, active resource types and the custom-server pool's total/idle/waiting counts. Database samples include tenant queue state, oldest queue age, backend/wait states, rollback, temporary-file and deadlock counters. Latency samples, exact build ID, compiled server-tree hash and source hashes remain in the output. The script fails if the compiled build changes while it runs.

The default `YASEIR_HEAP_SNAPSHOT_MODE=end` takes no heap snapshot until after the final settled memory sample. Snapshot generation allocates its own substantial native memory, so taking snapshots during a run can raise RSS independently of request retention. For object attribution, `YASEIR_HEAP_SNAPSHOT_MODE=checkpoints` collects snapshots between windows; it must be reported as a separate instrumented run. `summarize-gateway-heaps.py` reports constructor counts, object identity overlap and shallow bytes without publishing string values. It does not compute dominator retained bytes. Private raw snapshots, generated credentials, keys and the synthetic database are removed during cleanup.

The run is a bounded local diagnostic, not a production capacity ceiling, fleet-size certification, WAN test, physical print measurement or proof that no possible leak exists. Check host contention and use a quiet interval. Compare post-GC heap and retained object populations; RSS growth alone is insufficient to identify a leak. Set deployment SLOs only after measuring the intended tenant/agent mix, document sizes, queue depths and failure scenarios on the actual budget.

## Current resource bounds and scheduling

| Boundary | Implemented bound |
|---|---|
| PostgreSQL application pool | 20 clients per pool, 10-second connection wait, 30-second idle client timeout, rotation after 10,000 uses |
| Database work | 30-second statement deadline, 5-second lock wait, 30-second idle transaction deadline |
| API request body | 8 MiB general ceiling; agent registration 64 KiB, heartbeat 512 KiB, discovery 2 MiB, status writes 64 KiB |
| Concurrent request body reservation | 32 MiB authenticated and 8 MiB unauthenticated |
| Per-agent queued backlog | Fewer than 256 jobs and less than 128 MiB logical serialized payload |
| Per-agent claimed/printing work | 64 live jobs, serialized by a shared per-agent advisory transaction lock |
| Poll delivery | At most 20 claims and 64 MiB estimated response bytes per batch |
| WebSocket resources | 8 sockets per agent, 4,096 total admitted/pending sockets, 64 KiB inbound message, 16 in-flight messages per agent, 1 MiB buffered send threshold |
| WebSocket job envelope | 7.5 MiB serialized frame ceiling |
| Notification work | 16 active job notifications, 128 scheduled retry timers, bounded reconnect backoff |
| Retry/delivery budgets | Five safe retry returns and five delivery attempts; uncertain physical outcomes are fenced |
| Bulky terminal payload retention | 48 hours; payload-free receipts preserve idempotency; materialization sub-batches of 20 rows |

The custom server and compiled Next route graph can own separate bounded PostgreSQL pools in one process. Budget total database connections across both pools, every replica, LISTEN, migrations, Odoo and administration. The local heap census observed two application `BoundPool` instances. A cap of 20 on one pool is not a whole-deployment connection cap.

Polling prioritizes eligible stale, never-delivered claims, then queued jobs ordered by creation time; `FOR UPDATE SKIP LOCKED` avoids blocking competing claims. Per-agent locks and independent limits contain one agent's backlog, while tenant entitlements control admission. The synthetic restart cohort demonstrates progress for its six agents. It does not prove a universal weighted-fairness policy under arbitrary heterogeneous load.

## Database and session recovery

The dedicated Compose cluster now uses separate bootstrap, migration-owner and
runtime identities. Runtime gets public-table DML and sequence usage, with
`audit_events` limited to SELECT/INSERT, while
schema changes and migration-ledger access belong to the owner. Startup verifies
the actual restricted role before Gateway serves requests. See
[DATABASE_ROLES.md](DATABASE_ROLES.md) for explicit existing-volume conversion,
permission rollback, native denied-operation tests and the dedicated-cluster
limits. The synthetic soak's CREATEDB fixture role is separate from that
production runtime profile and must not be copied into a real Gateway deployment.

Run the disposable drill with the same isolated role and PostgreSQL client tools on PATH:

```sh
DATABASE_URL="$SYNTHETIC_DATABASE_URL" \
  node --import tsx scripts/acceptance/postgres-restore-drill.mjs /absolute/new/restore-evidence
```

It runs the repository's actual backup/restore scripts, verifies private 0600 backup permissions, and compares every row hash, index definition hash, sequence value and migration ledger before/after restore. Fixtures include tenant/agent/printer/API-key/installation associations, an active job and a retained receipt, plus nonempty password/session authority. The drill preserves account password hashes and memberships, legacy session cleanup records, rotated platform refresh history, customer and manager families, exact kind/tenant/role/family/SID bindings, credential fingerprints and original password/idle/absolute deadlines.

Wrong target confirmation, checksum tampering and nonempty target restoration must be refused without altering the target. Reapplying migrations must preserve all restored content. The separately saved synthetic signing key must preserve workspace credential-version proofs, and the platform fingerprint must still match the retained password hash. The script drops both disposable databases and removes private dumps/keys; cleanup failure is a failing gate.

For an authorized real restore, stop admission and preserve the Gateway database and signing-key identity together through protected custody. Restore into an explicitly selected isolated target first, validate the migration ledger and account/session authority, reconcile any rolled-back revocation history, then perform the separate recovery approval and traffic switch. Old backups still contain sensitive retired authentication material and retain their original access and retention controls. Preserve Odoo's own database, filestore, credential-encryption keys and external installation proof scope together as documented in its runtime-hardening profile. An independent clone requires a new external installation identity; copying historical operation IDs cannot silently grant retry authority.

Local drills do not establish off-site durability, backup encryption, tested production RPO/RTO or certificate renewal behavior. Those require the actual authorized storage and staging environment.

## Container acceptance

`scripts/acceptance/container-release.py` builds and scans the four exact image IDs and runs a fresh loopback HTTPS Compose stack with generated synthetic secrets. See `docs/runtime-hardening/README.md` for inputs, scope and invocation. A host that denies namespace/layer creation cannot produce an image-level scan or a Compose staging result. Preserve the exact failure and execute the script on a container-capable host; never relabel a source audit or a native Node HTTPS fixture as a final-image staging pass.
