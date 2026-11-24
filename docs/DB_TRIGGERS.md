# Database triggers and functions

The Gateway's 21-table License-Only Control Plane schema (`drizzle/0000_initial_schema.sql`) requires **no PostgreSQL triggers or custom SQL functions**.

## Retired Cloud Print Relay triggers

The legacy `print_jobs` triggers — the API-key tenant guard trigger and the `print_jobs_notify_agent_job_available` LISTEN/NOTIFY trigger — were removed along with the 11 Cloud Print Relay tables when the Gateway transitioned to the License-Only Control Plane schema.

Real-time print job wakeups are handled directly inside Odoo 19 via `pg_notify('print_gateway_job_ready', ...)`; the Gateway database does not store print jobs or dispatch notifications to Agents.

## Maintenance rule

Drizzle `src/db/schema.ts` and migration snapshots capture tables, constraints, and indexes, not SQL triggers or functions. If a future migration introduces any PostgreSQL trigger or function, document it in this inventory so schema-diff workflows do not silently drop or misreport it.
