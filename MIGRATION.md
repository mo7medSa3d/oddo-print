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

**Total**: 42 migrations (0000–0041)

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
