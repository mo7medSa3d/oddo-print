# Yaseir — manual-only billing schema

The production source of truth is **Platform Owner approval**, not a payment
provider callback. Billing operations, Stripe credentials, checkout mutations
and provider price identities are not part of the active schema.

## Migration policy

In the clean v7 baseline, the manual-only billing schema is built directly into
the single initial migration `drizzle/0000_initial_schema.sql` (superseding the
archived historical `0000`–`0111` chain). Fresh installations never create
Stripe/provider columns or the `legacy_billing` schema.

The final public schema retains business fields only:
- `plans`: identity, description, monthly quota entitlements, catalog visibility
  and display order, timestamps.
- `tenant_subscriptions`: workspace, plan, free/paid type, term, dates,
  monthly quota, status, manual reference, revision, suspension controls and
  timestamps.
- `subscription_changes`, `subscription_requests`:
  auditable actions and approval intent.

The migration archives provider plan and subscription metadata, historic
provider events and old period usage into a **non-public**
`legacy_billing` schema. Operational roles must not query the archive. No
operator UI, customer API or runtime authorization path uses this schema.

The migration runner archives every retired field and source row before
pending migration `0098`, including currency, interval, trial timestamps and
checkout/operation metadata. This runs in the migration transaction and
preserves the published SQL checksum. Use the runner; executing `0098` alone
omits some historical fields. If `0098` was already applied by an older
runner, recovery of omitted fields requires a pre-cutover backup or external
history; the remaining schema cannot reconstruct them.

Previously unapproved subscriptions carrying provider identities move to
`awaiting_activation` with a manual-review block. Owner-approved changes
(`save` or `renew`) remain unchanged.

## Release procedure

Back up the database and test restoration before migrating. Apply the normal
`npm run db:migrate` **once** as the migration owner before starting Gateway;
never run migration DDL on an active web process. Verify the migration journal
hashes, inspect `information_schema.columns` for obsolete fields and test
the four manual states. Then run fresh-database and historical-upgrade CI
suites. Do not delete the `legacy_billing` archive until a separate
approved retention policy permits it.

`AUDIT_REPAIRS` in `scripts/db-migrate.ts` is now empty (`[]`) because all
active tables, constraints, and indexes live in
`drizzle/0000_initial_schema.sql`. On every migration run,
`scripts/audit-runtime-privileges.sql` still revokes `PUBLIC` and runtime role
access from `legacy_billing` and `legacy_printing` whenever those archive
schemas exist on an upgraded database. For non-production resets to the clean
baseline, use `npm run db:reset` (blocked when `NODE_ENV=production` without
`--force`).
