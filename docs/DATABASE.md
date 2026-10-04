# Gateway database reference

Derived from the schema and production migration sources in this repository:

- `src/db/schema.ts` — the Drizzle schema every query is written against.
- `drizzle/*.sql` — immutable historical SQL.
- `scripts/db-migrate.ts` — hash ledger and versioned forward repairs applied by `npm run db:migrate`.

This file is derived, not hand-maintained: if a table is added, renamed or
dropped, regenerate the table matrix below so the documentation cannot drift
from the schema again.

## At a glance

| Metric | Value |
| --- | --- |
| Tables in `schema.ts` | 25 |
| Migration files | 77 (`0000` … `0076`) plus versioned forward repairs |
| Tables created by migration history and forward repairs | 32 |
| Legacy tables later dropped | 7 |
| Indexes created by migrations | 117 |
| Foreign keys added after table creation | 67 |

## Table matrix

| Table | schema.ts line | created in | indexes | late foreign keys |
| --- | --- | --- | --- | --- |
| `agents` | 108 | `0000_simple_tigra.sql` | 6 | 5 |
| `api_keys` | 177 | `0000_simple_tigra.sql` | 1 | 3 |
| `audit_events` | 466 | `0034_saas_control_plane.sql` | 3 | 0 |
| `auth_rate_limits` | 266 | `0005_auth_rate_limits.sql` | 4 | 0 |
| `billing_events` | 254 | `0037_customer_identity_billing.sql` | 2 | 0 |
| `discovered_devices` | 297 | `0010_discovery.sql` | 12 | 10 |
| `discovery_sessions` | 277 | `0010_discovery.sql` | 6 | 4 |
| `email_verification_tokens` | 212 | `0037_customer_identity_billing.sql` | 2 | 1 |
| `gateway_metrics` | 457 | `0015_metrics_and_agent_notifications.sql` | 0 | 0 |
| `job_events` | 416 | `0055_job_events_and_spooler_job_id.sql` | 4 | 2 |
| `manager_sessions` | 197 | `0000_simple_tigra.sql` | 3 | 1 |
| `password_reset_tokens` | 224 | `0037_customer_identity_billing.sql` | 2 | 1 |
| `plans` | 485 | `0034_saas_control_plane.sql` | 3 | 0 |
| `platform_sessions` | 43 | `0043_add_platform_owner.sql` | 2 | 0 |
| `print_job_receipts` | 562 | `scripts/db-migrate.ts` A86 | 1 | 0 |
| `print_jobs` | 348 | `0000_simple_tigra.sql` | 23 | 15 |
| `print_usage_periods` | 546 | `0061_print_usage_quota.sql` | 1 | 0 |
| `printers` | 135 | `0000_simple_tigra.sql` | 9 | 6 |
| `refresh_tokens` | 54 | `0073_refresh_tokens.sql` | 4 | 1 |
| `tenant_domains` | 18 | `0030_tenant_domains_and_manager_sessions.sql` | 3 | 0 |
| `tenant_invitations` | 236 | `0037_customer_identity_billing.sql` | 3 | 2 |
| `tenant_subscriptions` | 507 | `0034_saas_control_plane.sql` | 7 | 0 |
| `tenant_users` | 90 | `0028_add_multi_tenancy.sql` | 3 | 2 |
| `tenants` | 4 | `0028_add_multi_tenancy.sql` | 1 | 0 |
| `users` | 31 | `0028_add_multi_tenancy.sql` | 1 | 0 |

Every table declared in `schema.ts` is created by a migration, and every
table created by a migration is either declared in `schema.ts` or dropped
again later. There is no drift between the two.

## Legacy tables (created then dropped)

- `applications` — created in `0028_add_multi_tenancy.sql`, dropped in a later migration. Do not reintroduce.
- `branches` — created in `0001_phase1_branch_foundation.sql`, dropped in a later migration. Do not reintroduce.
- `destinations` — created in `0001_phase1_branch_foundation.sql`, dropped in a later migration. Do not reintroduce.
- `document_types` — created in `0002_add_document_types.sql`, dropped in a later migration. Do not reintroduce.
- `local_networks` — created in `0001_phase1_branch_foundation.sql`, dropped in a later migration. Do not reintroduce.
- `print_job_rate_limits` — created in `0016_print_job_rate_limits.sql`, dropped in a later migration. Do not reintroduce.
- `printer_bindings` — created in `0001_phase1_branch_foundation.sql`, dropped in a later migration. Do not reintroduce.

## Invariants enforced outside `schema.ts`

Several guarantees live only in SQL (CHECK constraints, partial unique
indexes, composite foreign keys and database triggers) because Drizzle
cannot express them. The most important ones:

- `0000_simple_tigra.sql`: agents_last_seen_idx; manager_sessions_expires_idx; print_jobs_agent_status_idx; print_jobs_printer_status_idx; print_jobs_status_expires_idx; printers_agent_id_idx
- `0001_phase1_branch_foundation.sql`: agents_branch_id_idx; agents_local_network_id_idx; api_keys_branch_id_idx; branches_enabled_idx; branches_name_idx; destinations_branch_id_idx
- `0002_add_document_types.sql`: document_types_branch_id_idx; document_types_name_idx
- `0003_add_idempotency_key.sql`: print_jobs_branch_idempotency_idx; print_jobs_branch_idempotency_unique
- `0004_add_job_delivery_tracking.sql`: print_jobs_claimed_at_idx
- `0005_auth_rate_limits.sql`: auth_rate_limits_locked_until_idx
- `0006_architecture_hardening.sql`: agents_gateway_id_global_unique; agents_lifecycle_idx; printers_gateway_id_global_unique; printers_lifecycle_idx
- `0007_auth_rate_limit_retention.sql`: auth_rate_limits_updated_at_idx
- `0010_discovery.sql`: discovered_devices_agent_id_idx; discovered_devices_agent_identity_unique; discovered_devices_branch_id_idx; discovered_devices_candidate_status_idx; discovered_devices_confidence_idx; discovered_devices_discovery_id_idx
- `0015_metrics_and_agent_notifications.sql`: 
- `0016_print_job_rate_limits.sql`: print_job_rate_limits_updated_idx
- `0017_notify_requeued_jobs.sql`: 
- `0018_global_print_job_idempotency.sql`: print_jobs_idempotency_unique
- `0021_scope_print_jobs_to_api_key.sql`: print_jobs_api_key_id_idx; print_jobs_idempotency_unique
- `0023_internal_print_job_idempotency.sql`: print_jobs_internal_idempotency_unique
- `0028_add_multi_tenancy.sql`: auth_rate_limits_locked_until_idx; auth_rate_limits_updated_at_idx; discovered_devices_agent_id_idx; discovered_devices_candidate_status_idx; discovered_devices_confidence_idx; discovered_devices_discovery_id_idx
- `0030_tenant_domains_and_manager_sessions.sql`: manager_sessions_tenant_idx; tenant_domains_primary_unique; tenant_domains_tenant_idx; tenant_domains_verified_idx
- `0032_pairing_code_hash_unique.sql`: agents_pairing_code_hash_pending_unique
- `0033_manager_identity.sql`: manager_sessions_user_idx
- `0034_saas_control_plane.sql`: audit_events_actor_idx; audit_events_resource_idx; audit_events_tenant_created_idx
- `0036_print_job_request_id.sql`: print_jobs_request_id_idx
- `0037_customer_identity_billing.sql`: billing_events_tenant_idx; billing_events_type_idx; email_verification_tokens_expires_idx; email_verification_tokens_user_idx; password_reset_tokens_expires_idx; password_reset_tokens_user_idx
- `0040_tenant_lifecycle.sql`: tenants_lifecycle_idx
- `0042_dos_indexes.sql`: print_jobs_tenant_agent_status_expiry_idx; print_jobs_tenant_created_idx
- `0043_add_platform_owner.sql`: platform_sessions_expires_idx; platform_sessions_user_idx
- `0044_single_platform_owner_idx.sql`: users_single_platform_owner_idx
- `0046_scope_internal_print_job_idempotency.sql`: print_jobs_internal_idempotency_unique
- `0047_desired_printer_reconciliation.sql`: printers_agent_lifecycle_desired_idx
- `0048_discovery_running_agent_unique.sql`: discovery_sessions_active_agent_unique
- `0049_tenant_scoped_idempotency_and_owner_unique.sql`: print_jobs_tenant_idempotency_unique; tenant_users_single_owner_idx
- `0050_billing_single_flight_state.sql`: tenant_subscriptions_billing_operation_key_unique; tenant_subscriptions_billing_operation_unique; tenant_subscriptions_checkout_idempotency_unique; tenant_subscriptions_checkout_session_unique; tenant_subscriptions_checkout_status_idx
- `0052_plan_catalog_management.sql`: plans_catalog_idx; plans_stripe_product_id_unique
- `0055_job_events_and_spooler_job_id.sql`: job_events_created_idx; job_events_job_id_idx; job_events_stage_idx; job_events_tenant_job_idx
- `0057_api_key_composite_index.sql`: print_jobs_tenant_api_key_idx
- `0061_print_usage_quota.sql`: print_usage_periods_tenant_period_end_idx
- `0070_discovered_device_identity.sql`: discovered_devices_tenant_agent_identity_idx; discovered_devices_tenant_agent_identity_unique
- `0073_refresh_tokens.sql`: refresh_tokens_expires_idx; refresh_tokens_family_idx; refresh_tokens_replaced_by_idx; refresh_tokens_user_idx


The production migration entry point is `npm run db:migrate` (`scripts/db-migrate.ts`). It applies missing content hashes in journal index order, under one PostgreSQL advisory transaction lock, so older journal timestamps cannot suppress 0033–0036 or 0074. Historical SQL and hashes remain immutable. The same transaction applies versioned forward audit repairs embedded in that script and records their hashes in the existing Drizzle ledger. Do not substitute the timestamp-only Drizzle migrator for deployment upgrades.

Terminal Agent reports require an immutable attempt claim token. A successful write retains its SHA-256 hash in `print_jobs.closed_claim_token_hash` while clearing the live execution token when appropriate. Retries of exactly the same terminal status and attempt receive `{success:true,status:<terminal status>}` without changing outcome, evidence or timestamps. Other attempts or statuses remain fenced. A new claim clears closed acknowledgement evidence. Agents retain outbox tokens until a bounded JSON acknowledgement confirms both success and the requested status. The database column is installed by the versioned forward repair in `scripts/db-migrate.ts`.

The forward payload constraint repair in `scripts/db-migrate.ts` coalesces both missing type and protocol discriminators. Absent/null type is rejected on new writes; NOT VALID preserves historic rows for explicit review. ORM and newest snapshot mirror this repaired constraint.

`tenant_subscriptions.checkout_request_params` stores immutable form parameters for one checkout intent. A forward repair installs this nullable JSONB column; missing legacy snapshots fail closed during external-mutation recovery.

`tenant_subscriptions.stripe_state_revision` is the monotonic fence for retrieved Stripe snapshots, independent of second-resolution event timestamps and app clocks. All Stripe state producers increment it; the embedded migration installs it at zero.

`plans.stripe_price_history` preserves current and retired Stripe Price IDs under a shared catalog-mutation advisory lock. Price IDs cannot be reassigned to another plan. Webhooks require exactly one current/historical mapping, independent of public/active catalog visibility. The forward migration seeds current IDs; operators must supply lost pre-upgrade historical mappings from Stripe/account evidence.

### `print_job_receipts`
Payload-free terminal receipts are inserted atomically with history cleanup under the tenant enqueue lock. They retain tenant/key uniqueness, SHA-256 of the canonical admission fingerprint, original job/owner identity, terminal status/error/timestamps and the closed attempt-token hash. They have no printer/agent/API-key foreign keys and survive resource removal. Only tenant deletion removes them; no time-based pruning is safe without an explicit idempotency expiry contract. Odoo single/batch lookups and closed Agent ACKs use the same scoped evidence after payload cleanup. The production hash migrator creates this table via its versioned forward repair.
