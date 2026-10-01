from odoo import SUPERUSER_ID


def migrate(cr, version):
    if not version:
        return

    # Before Branch → Agent assignments became the authoritative source,
    # existing bindings could carry a valid runtime agent without a matching
    # assignment row. Preserve those live configuration choices explicitly so
    # the new assignment-filtered picker does not hide already configured
    # agents after upgrade.
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
        ON CONFLICT (company_id, branch_id, runtime_agent_id) DO NOTHING
        """,
        (SUPERUSER_ID, SUPERUSER_ID),
    )
