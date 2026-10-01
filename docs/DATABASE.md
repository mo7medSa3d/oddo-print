# Gateway database reference

Generated from the only two sources of truth in this repository:

- `src/db/schema.ts` — the Drizzle schema every query is written against.
- `drizzle/*.sql` — the ordered migration history applied by `npm run db:migrate`.

This file is derived, not hand-maintained: if a table is added, renamed or
dropped, regenerate the table matrix below so the documentation cannot drift
from the schema again.

## At a glance

| Metric | Value |
| --- | --- |
| Tables in `schema.ts` | 24 |
| Migration files | 76 (`0000` … `0075`) |
| Tables created by migrations | 31 |
| Legacy tables later dropped | 7 |
| Indexes created by migrations | 117 |
| Foreign keys added after table creation | 67 |

## Table matrix

| Table | schema.ts line | created in | indexes | late foreign keys |
| --- | --- | --- | --- | --- |
| `agents` | 108 | `0000_simple_tigra.sql` | 6 | 5 |
| `api_keys` | 177 | `0000_simple_tigra.sql` | 1 | 3 |
| `audit_events` | 457 | `0034_saas_control_plane.sql` | 3 | 0 |
| `auth_rate_limits` | 266 | `0005_auth_rate_limits.sql` | 4 | 0 |
| `billing_events` | 254 | `0037_customer_identity_billing.sql` | 2 | 0 |
| `discovered_devices` | 297 | `0010_discovery.sql` | 12 | 10 |
| `discovery_sessions` | 277 | `0010_discovery.sql` | 6 | 4 |
| `email_verification_tokens` | 212 | `0037_customer_identity_billing.sql` | 2 | 1 |
| `gateway_metrics` | 448 | `0015_metrics_and_agent_notifications.sql` | 0 | 0 |
| `job_events` | 414 | `0055_job_events_and_spooler_job_id.sql` | 4 | 2 |
| `manager_sessions` | 197 | `0000_simple_tigra.sql` | 3 | 1 |
| `password_reset_tokens` | 224 | `0037_customer_identity_billing.sql` | 2 | 1 |
| `plans` | 476 | `0034_saas_control_plane.sql` | 3 | 0 |
| `platform_sessions` | 43 | `0043_add_platform_owner.sql` | 2 | 0 |
| `print_jobs` | 348 | `0000_simple_tigra.sql` | 23 | 15 |
| `print_usage_periods` | 533 | `0061_print_usage_quota.sql` | 1 | 0 |
| `printers` | 135 | `0000_simple_tigra.sql` | 9 | 6 |
| `refresh_tokens` | 54 | `0073_refresh_tokens.sql` | 4 | 1 |
| `tenant_domains` | 18 | `0030_tenant_domains_and_manager_sessions.sql` | 3 | 0 |
| `tenant_invitations` | 236 | `0037_customer_identity_billing.sql` | 3 | 2 |
| `tenant_subscriptions` | 497 | `0034_saas_control_plane.sql` | 7 | 0 |
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

