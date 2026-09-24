# Migration Guide

> See also: [OPERATIONS.md](./OPERATIONS.md)

## Overview

The Gateway uses **Drizzle ORM** for database migrations. All migrations are SQL files in `drizzle/` with metadata in `drizzle/meta/_journal.json`.

## Running Migrations

```bash
DATABASE_URL="postgresql://..." npm run db:migrate
```

This runs `scripts/db-migrate.ts` which applies all pending migrations from `drizzle/` in journal order.

## Migration History

| Range | Count | Description |
|-------|-------|-------------|
| 0000–0027 | 28 | Initial schema through single-tenant features |
| 0028 | 1 | Multi-tenancy migration (composite keys, tenant_id columns) |
| 0029–0039 | 11 | Post-tenancy features (billing, audit, lifecycle, rate limits) |
| 0040 | 1 | Tenant lifecycle (suspend/delete) |
| 0041 | 1 | Composite FK prerequisite fix (idempotent) |
| 0042 | 1 | Denial-of-service protection indexes |
| 0043 | 1 | Platform owner account |
| 0044 | 1 | Single platform owner uniqueness |
| 0045 | 1 | Audit events platform scope |
| 0046 | 1 | Internal print-job idempotency scope |
| 0047 | 1 | Desired printer state reconciliation |
| 0048 | 1 | Running discovery session per-agent uniqueness |
| 0049 | 1 | Tenant-scoped idempotency and owner uniqueness |
| 0050 | 1 | Billing single-flight operation state |
| 0051 | 1 | Agent lifecycle revision |
| 0052 | 1 | Plan catalog management |
| 0053 | 1 | Discovery spooler name |
| 0054 | 1 | Odoo Gateway activation state |
| 0055 | 1 | Job events and spooler job id |
| 0056 | 1 | Discovered device class NOT NULL |
| 0057 | 1 | API key composite index |
| 0058 | 1 | Scope Odoo activation to the installation API key |
| 0059 | 1 | Remove API key scope and document-type restrictions |
| 0060–0069 | 10 | Billing, usage, time authority, key rotation, job-event hardening, and claim-id redaction |
| 0070 | 1 | Durable discovered-device identity for per-Agent sync convergence |
| 0071 | 1 | Remove obsolete print-job rate-limit table |

**Total**: 72 migrations (0000–0071)

## Migration Policy

### Never Rewrite History

- **Never delete** existing migration files
- **Never rename** migration files
- **Never reorder** migrations
- **Never modify** migration content after deployment

### Forward Migrations Only

All fixes must use **new forward migrations** with idempotent guards:

```sql
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'my_constraint'
  ) THEN
    ALTER TABLE my_table ADD CONSTRAINT my_constraint ...;
  END IF;
END $$;
```

### Statement Breakpoints

Drizzle splits SQL files on `--> statement-breakpoint` markers. Each segment is executed as a separate statement. **Missing breakpoints cause silent failures** when consecutive `DO $$ ... END $$;` blocks are concatenated into a single query.

Always add breakpoints between independent SQL statements:

```sql
DO $$ BEGIN ... END $$;
--> statement-breakpoint
DO $$ BEGIN ... END $$;
```

### Fresh Replay Requirement

Every migration must be valid when replayed from an empty database. CI verifies this on every push:

```bash
# CI step: create empty DB, replay all migrations
createdb test_db
DATABASE_URL="..." npm run db:migrate
```

## Troubleshooting

### Migration 0029: Ambiguous Legacy Ownership

This migration intentionally stops if it detects ambiguous legacy ownership (multiple agents claiming the same printer). Resolve the ownership manually, then re-run.

### Migration 0032: Duplicate Pairing Codes

This migration stops if two pending pairing codes share one hash. Disable and re-enable the affected agents to regenerate codes, then re-run.

### CI Failure: Missing Composite FK Prerequisites

**Symptom**: `ERROR 42830: there is no unique constraint matching given keys for referenced table`

**Root cause**: Missing `--> statement-breakpoint` separators between DO blocks in earlier migrations. Fixed in migration 0041 (idempotent forward migration).

## Schema Verification

CI runs a schema tripwire test that verifies the migrated database matches the Drizzle schema definition:

```bash
npm run test:integration  # includes ci-tripwire.check.ts
```
