from odoo import SUPERUSER_ID


def migrate(cr, version):
    if not version:
        return

    # The previous composite UNIQUE includes nullable branch_id, so PostgreSQL
    # allowed duplicate company-wide assignments (branch_id IS NULL). Keep one
    # deterministic row before the new partial unique index is created.
    cr.execute(
        """
        DELETE FROM print_gateway_runtime_agent_assignment a
        USING (
            SELECT company_id, runtime_agent_id, MIN(id) AS keep_id
            FROM print_gateway_runtime_agent_assignment
            WHERE branch_id IS NULL
            GROUP BY company_id, runtime_agent_id
        ) kept
        WHERE a.branch_id IS NULL
          AND a.company_id = kept.company_id
          AND a.runtime_agent_id = kept.runtime_agent_id
          AND a.id <> kept.keep_id
        """
    )
