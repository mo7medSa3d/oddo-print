"""Move existing installations to the single Direct Odoo Agent data plane.

Old Cloud-delivered jobs with an external job ID are quarantined as unknown
before their remote identifiers are removed. They are never re-queued.
"""


def _has_column(cr, table, column):
    cr.execute(
        "SELECT 1 FROM information_schema.columns WHERE table_name = %s AND column_name = %s",
        (table, column),
    )
    return bool(cr.fetchone())


def _rename_column(cr, table, old, new):
    if _has_column(cr, table, old) and not _has_column(cr, table, new):
        cr.execute(f'ALTER TABLE "{table}" RENAME COLUMN "{old}" TO "{new}"')


def _drop_columns(cr, table, columns):
    for column in columns:
        if _has_column(cr, table, column):
            cr.execute(f'ALTER TABLE "{table}" DROP COLUMN "{column}" CASCADE')


def migrate(cr, version):
    # Rename job configuration and claim columns.
    _rename_column(cr, "print_gateway_print_job", "print_config_id", "print_config_id")
    _rename_column(cr, "print_gateway_print_job", "submit_claim_token", "claim_token")
    _rename_column(cr, "print_gateway_print_job", "submit_claimed_at", "claimed_at")

    # Preserve physical uncertainty for all jobs that crossed the old Cloud
    # queue. The new Agent must never replay those operations automatically.
    if _has_column(cr, "print_gateway_print_job", "gateway_job_id"):
        cr.execute("""
            UPDATE print_gateway_print_job
               SET status = 'unknown',
                   last_error = COALESCE(NULLIF(last_error, ''),
                       'LEGACY_CLOUD_JOB_REQUIRES_MANUAL_REVIEW'),
                   completed_at = COALESCE(completed_at, write_date, NOW()),
                   next_retry_at = NULL
             WHERE gateway_job_id IS NOT NULL
        """)
    cr.execute("""
        UPDATE print_gateway_print_job
           SET status = 'unknown',
               last_error = COALESCE(NULLIF(last_error, ''),
                   'LEGACY_CLOUD_STATUS_REQUIRES_MANUAL_REVIEW'),
               completed_at = COALESCE(completed_at, write_date, NOW()),
               next_retry_at = NULL
         WHERE status IN ('submitted', 'partial')
    """)
    _drop_columns(cr, "print_gateway_print_job", [
        "gateway_job_id",
        "gateway_submission_state",
        "gateway_installation_id",
        "gateway_wire_idempotency_key",
        "gateway_idempotency_version",
        "last_status_polled_at",
        "fallback_binding_id",
    ])

    # The previous sharing flag is now an explicit local Odoo availability
    # flag. Preserve each Agent's existing per-printer choice.
    _rename_column(cr, "print_gateway_printer", "shared_with_gateway", "available_to_odoo")

    # Convert old opaque Agent IDs into real Odoo Agent relations.
    if _has_column(cr, "print_gateway_runtime_agent_assignment", "runtime_agent_id"):
        if not _has_column(cr, "print_gateway_runtime_agent_assignment", "agent_id"):
            cr.execute("ALTER TABLE print_gateway_runtime_agent_assignment ADD COLUMN agent_id INTEGER")
        cr.execute("""
            UPDATE print_gateway_runtime_agent_assignment assignment
               SET agent_id = agent.id
              FROM print_gateway_agent agent
             WHERE agent.agent_uid = assignment.runtime_agent_id
               AND agent.company_id = assignment.company_id
        """)
        # Old Cloud-only IDs cannot be assigned in Direct Odoo mode.
        cr.execute("DELETE FROM print_gateway_runtime_agent_assignment WHERE agent_id IS NULL")
        cr.execute("ALTER TABLE print_gateway_runtime_agent_assignment ALTER COLUMN agent_id SET NOT NULL")
        cr.execute("ALTER TABLE print_gateway_runtime_agent_assignment DROP COLUMN runtime_agent_id CASCADE")

    if _has_column(cr, "print_gateway_binding", "runtime_agent_id"):
        if not _has_column(cr, "print_gateway_binding", "agent_id"):
            cr.execute("ALTER TABLE print_gateway_binding ADD COLUMN agent_id INTEGER")
        cr.execute("""
            UPDATE print_gateway_binding binding
               SET agent_id = agent.id
              FROM print_gateway_agent agent
             WHERE agent.agent_uid = binding.runtime_agent_id
               AND agent.company_id = binding.company_id
        """)
        # Do not leave a formerly Gateway-bound route silently enabled.
        if _has_column(cr, "print_gateway_binding", "enabled"):
            cr.execute("UPDATE print_gateway_binding SET enabled = FALSE WHERE agent_id IS NULL")
        cr.execute("ALTER TABLE print_gateway_binding DROP COLUMN runtime_agent_id CASCADE")
    _drop_columns(cr, "print_gateway_binding", ["fallback_binding_id"])

    # The Direct Odoo Print Service config is deliberately local. The licence
    # server URL/key are read from print_gateway.* ir.config_parameter values.
    _drop_columns(cr, "print_gateway_gateway_config", [
        "gateway_url", "gateway_api_key", "cloud_url", "cloud_api_key",
        "runtime_agent_id", "idempotency_v2_enabled", "installation_id",
        "enabled_sync_revision", "last_enabled_sync_revision", "pending_sync_revision",
        "pending_sync_started_at", "gateway_sync_state", "gateway_sync_message",
        "cloud_sync_revision", "last_cloud_sync_revision", "pending_cloud_sync_revision",
        "pending_cloud_sync_started_at", "cloud_sync_state", "cloud_sync_message",
        "pending_disable_gateway_url", "pending_disable_gateway_api_key",
        "pending_disable_cloud_url", "pending_disable_cloud_api_key",
        "last_gateway_migration_sync_at", "last_gateway_migration_sync_error",
        "last_cloud_migration_sync_at", "last_cloud_migration_sync_error",
    ])

    # Disable retired Cloud queue/heartbeat workers even on installs where the
    # old cron records were loaded as noupdate data.
    cr.execute("""
        UPDATE ir_cron cron
           SET active = FALSE
          FROM ir_model_data data
         WHERE data.model = 'ir.cron'
           AND data.res_id = cron.id
           AND data.module = 'print_gateway'
           AND data.name IN (
               'cron_submit_pending_gateway_print_jobs',
               'cron_sync_gateway_print_job_status',
               'cron_sync_gateway_enabled_state',
               'cron_refresh_gateway_agent_inventory'
           )
    """)
