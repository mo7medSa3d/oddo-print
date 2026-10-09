# Odoo 19 binding/report routing upgrade (F010/O2)

Version `19.0.2.12.0` adds nullable `print.gateway.job.destination_key`. This field pins a durable Odoo destination model/id across pre-dispatch fallback; it does not grant permission by display name. New jobs persist it; old rows without it fail closed for automatic fallback and may require explicit operator reprint after verified outcome.

## Required authorized staging procedure

1. Capture an Odoo database snapshot and a matching Odoo filestore snapshot, with a verified restore in an isolated staging instance. Record installed addon version, Odoo19 exact edition, active API key revision, and current queued/printing/reconciling jobs. Freeze real print submissions before changing addon code.
2. Install the exact tested addon source and run the official Odoo19 addon upgrade for `print_gateway` in staging (example using approved Odoo binary: `odoo-bin -d <staging_database> -u print_gateway --stop-after-init`; supply the correct addons path and credentials through your approved deployment process). Do not point this command at a live production database. Confirm the nullable `destination_key` column exists and indexes/constraints/migrations match the deployed module schema.
3. Test two reports sharing one stock operation, exact report-A and B selection, report action without stock operation, branch/root priority, explicit exact printer, no-binding native fallback, raw labels and all POS/receipt/kitchen routes. Recheck fallback on disabled or renamed printer; must never use an unrelated destination display name. Verify no cross-company or unauthorized binding is selected.
4. Upgrade the client POS assets and clear versioned caches in a controlled manner; test quantity and notes edited during in-flight kitchen/bar dispatch against native `last_order_preparation_change` and consecutive real submissions. Test accepted, failed, unknown, partial and retry outcomes.
5. On error, stop Agent submissions, preserve all job and idempotency evidence, restore matching database+filestore snapshots (and matching addon code) in an isolated restore verification. Do not blindly replay unknown print outcomes.

These are acceptance procedures only. No installed Odoo19, PostgreSQL upgrade/restore, hardware or UI acceptance was performed in this local audit.
