# Multi-Tenancy Architecture

> See also: [ARCHITECTURE.md](./ARCHITECTURE.md) § 3, [SECURITY_MODEL.md](./SECURITY_MODEL.md)

## Model: Pool Tenancy

All tenants share a single PostgreSQL database and schema. Tenant isolation is enforced at the application level through composite foreign keys and mandatory `tenant_id` filtering on every query.

## Database Isolation

### Tenant-Scoped Tables

Every runtime table carries a `tenant_id` column with:

| Constraint | Purpose |
|-----------|---------|
| `NOT NULL` | Every row belongs to exactly one tenant |
| `REFERENCES tenants(id)` | Referential integrity |
| `UNIQUE(tenant_id, id)` | Composite primary identity for cross-table FKs |

### Composite Foreign Keys

Cross-table references enforce tenant boundaries:

```
printers(tenant_id, agent_id) → agents(tenant_id, id)
print_jobs(tenant_id, printer_id) → printers(tenant_id, id)
print_jobs(tenant_id, agent_id) → agents(tenant_id, id)
api_keys(tenant_id) → tenants(id)
```

A query joining `printers` to `agents` cannot accidentally cross tenant boundaries because the FK constraint requires `tenant_id` to match on both sides.

### No PostgreSQL RLS (Documented Gap)

PostgreSQL Row-Level Security is **not enabled**. All tenant filtering happens in the application layer (Drizzle ORM queries include `WHERE tenant_id = ?`). RLS is a recommended future defense-in-depth addition.

## Tenant Lifecycle

| State | Meaning | Effect |
|-------|---------|--------|
| `active` | Normal operation | Full access |
| `suspended` | Temporarily disabled (billing, admin action) | All API calls return 403 via `requireActiveTenant()` |
| `deleted` | Permanently removed | All API calls return 403 |

The guard runs at every authenticated request entry point:
- Agent authentication (`validateAgent`) checks tenant lifecycle
- API key authentication checks tenant lifecycle
- Manager session checks tenant lifecycle

## Tenant Domains

Each tenant can have one or more verified domain names (`tenant_domains` table). These enable per-tenant login routing without exposing internal tenant IDs.

## Billing Integration

Each tenant has a `tenant_subscriptions` row tracking:
- Stripe customer and subscription IDs
- Plan reference
- Status (trialing, active, past_due, paused, cancelled)
- Current period end

Stripe webhook events are processed idempotently (dedup by `event_id`) with proper event ordering (`stripeLastEventCreatedAt`).

## Future Path

The architecture supports incremental evolution:

1. **Pool** (current) — shared DB, shared schema, application-level isolation
2. **Bridge** — schema-per-tenant within the same database
3. **Silo** — database-per-tenant
4. **Cells/Stamps** — infrastructure-per-region

Each step adds isolation at the cost of operational complexity. The current pool model is appropriate for the product's scale.
