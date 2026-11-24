from odoo import SUPERUSER_ID


def migrate(cr, version):
    if not version:
        return

    # Before Branch → Agent assignments became the authoritative source,
    # existing bindings could carry a valid runtime agent without a matching
    # assignment row. Preserve those live configuration choices explicitly so
    # the new assignment-filtered picker does not hide already configured
    # agents after upgrade.
    # PostgreSQL UNIQUE treats NULL as distinct, so ON CONFLICT
    # (company_id, branch_id, runtime_agent_id) never matches company-wide rows
    # (branch_id IS NULL). A re-run would insert duplicates. Use a NULL-safe
    # NOT EXISTS guard so the migration is idempotent for both scopes.
    cr.execute(
        """
        INSERT INTO print_gateway_runtime_agent_assignment (
            company_id,
            branch_id,
            runtime_agent_id,
            enabled,
            create_uid,
            write_uid,
            create_date,
            write_date
        )
        SELECT DISTINCT
            b.company_id,
            b.branch_id,
            BTRIM(b.runtime_agent_id),
            TRUE,
            %s,
            %s,
            NOW(),
            NOW()
        FROM print_gateway_binding b
        WHERE b.runtime_agent_id IS NOT NULL
          AND BTRIM(b.runtime_agent_id) <> ''
          AND NOT EXISTS (
              SELECT 1 FROM print_gateway_runtime_agent_assignment a
              WHERE a.company_id IS NOT DISTINCT FROM b.company_id
                AND a.branch_id IS NOT DISTINCT FROM b.branch_id
                AND a.runtime_agent_id IS NOT DISTINCT FROM BTRIM(b.runtime_agent_id)
          )
        """,
        (SUPERUSER_ID, SUPERUSER_ID),
    )
