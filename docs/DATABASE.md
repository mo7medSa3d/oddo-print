# Gateway database reference

The Gateway uses PostgreSQL through the shared `pg` pool and Drizzle definitions in [`src/db/index.ts`](../src/db/index.ts) and [`src/db/schema.ts`](../src/db/schema.ts). This document describes the checked-in License-Only Control Plane schema and migration process. It is not evidence that a deployment was migrated, backed up, restored, or tested successfully.

Production Compose separates bootstrap administration, migration ownership and
runtime DML. Runtime has no DDL, temporary-table, cluster-administration or
migration-ledger privileges. The explicit role job supports existing volumes
and records permission rollback metadata; see [PostgreSQL deployment roles](DATABASE_ROLES.md).

## Schema inventory

There are **21 current application tables** defined in **1 clean initial SQL migration (`drizzle/0000_initial_schema.sql`)** for the License-Only Control Plane, with an empty `AUDIT_REPAIRS` array retained in [`scripts/db-migrate.ts`](../scripts/db-migrate.ts) for migration harness compatibility. The migration ledger, `drizzle.__drizzle_migrations`, is separate from the application tables. The 11 legacy Cloud Print Relay tables were removed; direct print queues, agents, printers, and job history live in Odoo 19.

| Table | Purpose and identity | Scope and relevant constraints |
| --- | --- | --- |
| `tenants` | Workspace identity, name, lifecycle and lifecycle timestamps | Primary key `id`; lifecycle CHECK (`active`, `suspended`, `deleted`) and `odoo_idempotency_mode` CHECK |
| `users` | Global account identity, password hash, email verification and Platform Owner flag | Globally unique email; partial unique index permits at most one Platform Owner |
| `tenant_users` | Membership and current role for a user in a workspace | Unique `(user_id, tenant_id)` identity and at most one owner per tenant; role CHECK (`owner`, `admin`); no formal primary key |
| `platform_sessions` | Revocation and cleanup of pre-policy Platform sessions; these sessions are never authorized | JTI primary key, user reference, expiry and revocation |
| `platform_session_security` | Per-family administrator assurance and freshness | Current salted-verifier fingerprint, password/activity timestamps, thirty-minute idle and eight-hour absolute expiry, revocation |
| `workspace_session_security` | Persisted workspace password proof and activity for each refresh family | Exact kind/tenant/user/credential binding and password time, thirty-minute idle, five-minute privileged confirmation and original absolute deadline; missing assurance denies access |
| `manager_sessions` | Revocation and cleanup of pre-policy workspace sessions; these sessions are never authorized | JTI primary key, tenant, optional user, role, expiry and revocation; not the current v2 access-token ledger |
| `refresh_tokens` | Hashed opaque v2 refresh credentials, family history and replacement/revocation evidence | Unique token hash; family/user/tenant indexes; kind/scope and time-order CHECKs; replacement self-reference |
| `email_verification_tokens` | Single-use mailbox verification credential hashes | User reference, optional invitation reference, unique token hash, expiry and consumed timestamp |
| `password_reset_tokens` | Password reset/setup credential hashes | User reference, unique token hash, expiry and consumed timestamp |
| `tenant_invitations` | Pending/accepted/revoked workspace invitations | Tenant and inviter references, unique token hash, expiry, bounded member role (`admin`) |
| `api_keys` | Integration credential hashes, revocation/read-only grace and Odoo activation revision | Tenant reference, unique credential hash and `(tenant_id, id)`; read-only grace requires revocation |
| `odoo_installations` | Operator-enrolled Gateway identity for each independently managed Odoo deployment; proof hash, state and lifecycle | Unique `(tenant_id, id)`; proof hash never exposed in audit rows |
| `odoo_installation_credentials` | Preserved credential-to-installation ownership, including key rotations | Primary key `(tenant_id, installation_id, api_key_id)` and composite tenant/installation and tenant/API-key foreign keys; one key may serve several independent installations |
| `gateway_metrics` | Shared operational counters | Global metric-name primary key; nonnegative value; written by the metrics service |
| `audit_events` | Actor/action/resource audit metadata | Tenant is required except for Platform actor records; actor type CHECK and scope/time indexes; append-only for runtime role |
| `auth_rate_limits` | Authentication attempt windows, failure counters and lockout expiry | Global opaque-key primary key; account/source-IP scope is encoded by the application, not a tenant column |
| `plans` | Public/private manual plan catalog and entitlement definitions | Global plan identity/name; active/public/display-order fields, plus optional USD/SAR display price in integer minor units |
| `tenant_subscriptions` | Manually approved plan, term, quota, status, revision and expiry | One row per workspace; plan reference; four allowed statuses (`awaiting_activation`, `active`, `expired`, `suspended`), manually approved contract dates and print-cycle anchor; no provider checkout columns |
| `subscription_requests` | Verified requester snapshots, requested/approved plan and term, and review outcomes | Tenant/user/plan references; at most one `pending` request per tenant; per-tenant unique idempotency key |
| `subscription_changes` | Append-only business history of every manual subscription mutation | Tenant and optional actor references; per-tenant unique idempotency key; before/after JSONB snapshots |

The consolidated clean baseline (`drizzle/0000_initial_schema.sql`) omits all retired Stripe/checkout columns from `plans` and `tenant_subscriptions` and does not create `legacy_billing` or `legacy_printing` on fresh installations. On previously upgraded databases where `legacy_billing` or `legacy_printing` exists, historical records remain non-public and denied to the Gateway runtime by `scripts/audit-runtime-privileges.sql`. Explicitly approved manual subscriptions remain authoritative. See [Manual-only database](MANUAL_ONLY_DATABASE.md).

The schema retains global account, catalog, metric and authentication data alongside tenant-scoped data. A missing `tenant_id` on a global table is not by itself an isolation defect. Conversely, the existence of a tenant column does not authorize access to a row.

## Isolation and state invariants

Isolation is enforced by authenticated tenant context, permission checks, ownership predicates and transactional revalidation in the Gateway. The supplied migrations do not enable PostgreSQL row-level security. Composite foreign keys add database enforcement where declared; they do not replace current-actor or tenant-lifecycle checks.

`users_single_platform_owner_idx` and the tenant-owner partial unique index impose **at most one** owner at their respective scopes. They do not create an owner or guarantee that one exists. Account/bootstrap and ownership-transfer transactions enforce those workflows.

## Authentication and sensitive data

Current browser access JWTs are short-lived and are not stored as refresh-token rows. The `refresh_tokens` table holds hashes of opaque refresh secrets, family history and revocation evidence. Validation also checks the live principal and current membership. Legacy workspace and platform sessions are denied because they lack current persisted assurance. No old or missing session is silently promoted. See [SECURITY.md](../SECURITY.md) for cookie, rotation and expiry behavior.

API-key and Odoo installation proof columns contain credential hashes, not recoverable raw bearer secrets. Passwords use the account password-hashing implementation. A database backup still contains sensitive data: credential hashes, account identifiers, archived legacy records (on upgraded databases) and operational metadata. Restrict database/backup access and apply deployment encryption and retention controls; the schema does not encrypt all of those columns. Preserve the independent JWT signing key and Ed25519 license signing key through protected custody.

Audit rows are persisted in PostgreSQL, but not every audit write is atomic with its business operation. Some paths write best effort after commit. The audit table is not an external alert-delivery service or an immutable storage boundary against a privileged database account.

## Connection and transaction behavior

The runtime accepts `DATABASE_URL` or structured `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` and password settings through the secret-loading implementation. The supplied Compose stack reads its database password from a mounted secret file. Never put real connection credentials in this reference or command logs.

The shared pool uses UTC sessions and UTC serialization for JavaScript dates. Most schema timestamps are timezone-naive and interpreted as UTC; `gateway_metrics.updated_at` is explicitly timezone-aware. Do not change session timezone or reinterpret historical naive values as local wall-clock times.

Current pool defaults are 20 connections, a 10-second connection timeout, 30-second idle/statement timeouts, a 5-second lock timeout and recycling after 10,000 uses. These are implementation settings, not throughput guarantees.

The shipped Compose profile separates bootstrap administration, a migration owner and a reduced-privilege runtime role. Its ordered role setup, owner-only migration and runtime verification jobs complete before Gateway starts. Runtime credentials cannot perform schema changes or read the migration ledger. Existing volumes require the explicit conversion and rollback procedure in [DATABASE_ROLES.md](DATABASE_ROLES.md).

## Applying migrations

With the intended database connection configured, the application command is:

```sh
npm run db:migrate
```

For non-production development or test environments that need a clean slate, drop and recreate the `drizzle` and `public` schemas before re-applying `drizzle/0000_initial_schema.sql`:

```sh
npm run db:reset
```

`scripts/db-migrate.ts --reset` refuses to run when `NODE_ENV=production` unless `--force` is explicitly passed.

`scripts/db-migrate.ts` reads `drizzle/meta/_journal.json`, begins a transaction, sets `LOCAL search_path TO public`, ensures `drizzle.__drizzle_migrations` exists, and acquires an `ACCESS EXCLUSIVE` lock on `drizzle.__drizzle_migrations`. It checks recorded content hashes in `drizzle.__drizzle_migrations`, applies missing journal entries in order (starting from the single clean `drizzle/0000_initial_schema.sql` baseline), runs any `AUDIT_REPAIRS` entries (currently empty), and reapplies [`scripts/audit-runtime-privileges.sql`](../scripts/audit-runtime-privileges.sql) to preserve append-only `audit_events` permissions for the runtime role. Success commits; any failure rolls back the transaction.

Append new migrations with `npm run db:generate` rather than editing `drizzle/0000_initial_schema.sql` after deployment, deleting migration-ledger rows, or substituting `db:push` for the production migration path. The supplied Compose Gateway depends on successful completion of its separate migration service.

The application table count excludes the migration-ledger schema and isolated test-worker schemas. Tests may create temporary schemas/databases; their results do not establish the state of a production database.

## Backup, restore and verification

[`scripts/postgres-backup.sh`](../scripts/postgres-backup.sh) and [`scripts/postgres-restore.sh`](../scripts/postgres-restore.sh) implement the repository's logical backup/restore workflow. Follow [DEPLOYMENT.md](../DEPLOYMENT.md) for protected credentials, independent backup storage, archive/checksum checks and an isolated restore target. A backup file alone is not evidence of a successful restore or a measured recovery time.

After an isolated restore, run the current migrations and application checks before admitting traffic, and verify that tenant, subscription, API key, Odoo installation, and session authority records match expected state.

Run the source consistency gate without a database connection:

```sh
npm run db:docs:check
```

This checks current table names against schema declarations, migration creates/drops and this document, plus the counts in `ARCHITECTURE.md`. It does not apply migrations or validate a live database, every column/index definition, tenant authorization, or backup recovery. Use the repository's PostgreSQL integration suites and deployment verification procedure for those separate checks.

## Manual subscriptions (V4)

- `subscription_requests`: verified authenticated requester identity snapshots, workspace/plan relationship, one pending request per workspace, request idempotency/digest, reviewer decision/reason/time and resulting subscription revision. Historical requester names remain blank if never recorded; never inferred from an email.
- `subscription_changes`: append-only business history of every manual subscription mutation and migration, actor, old/new values, reason, request digest and per-workspace idempotency key. Every application write also records an `audit_events` entry in the same transaction.

`tenant_subscriptions` stores free/paid type, optional finite monthly quota override, monthly/yearly/custom term, internal reference and revision. New status defaults to `awaiting_activation`. Runtime requires explicit active status, valid start/end, unblocked entitlement and an active tenant fence. `users.display_name` is nullable for historical accounts. Retired provider columns survive only as private `legacy_billing` archive evidence on upgraded databases.

### Workspace membership access

`tenant_users.role` remains a compatibility field restricted to `admin`
and the internal `owner` marker; neither represents additional privileges.
Every enrolled person receives the fixed operational Full Access permission set,
excluding all billing, invitation, membership mutation, and platform
powers. Only a separately authenticated Platform Owner may change membership or billing.
A future verified schema cutover will be required to physically drop the role field.
