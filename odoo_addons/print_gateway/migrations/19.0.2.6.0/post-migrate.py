from odoo import api, SUPERUSER_ID


def migrate(cr, version):
    """Backfill pending-sync bookkeeping for rows pending before this version.

    The staleness fence reads pending_sync_started_at. Rows that entered the
    pending state before the field existed (stuck on "Syncing" across an
    upgrade) would otherwise carry no start timestamp; stamp them from their
    own write_date so the fence can age them out immediately instead of
    leaving an endless spinner on the form.
    """
    if not version:
        return
    cr.execute(
        """
        UPDATE print_gateway_gateway_config
        SET pending_sync_revision = enabled_sync_revision,
            pending_sync_started_at = write_date
        WHERE enabled_sync_revision IS NOT NULL
          AND enabled_sync_revision != COALESCE(last_enabled_sync_revision, -1)
          AND pending_sync_started_at IS NULL
        """
    )
