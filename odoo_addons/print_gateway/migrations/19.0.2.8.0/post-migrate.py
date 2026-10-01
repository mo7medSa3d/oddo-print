from odoo import SUPERUSER_ID


def migrate(cr, version):
    if not version:
        return

    # The previous composite UNIQUE includes nullable branch_id, so PostgreSQL
    # allowed duplicate company-wide assignments (branch_id IS NULL). Keep one
    # deterministic row per company/agent, preferring an enabled assignment
    # and then the oldest row, before the new partial unique index is created.
    cr.execute(
        """
        WITH kept AS (
            SELECT DISTINCT ON (company_id, runtime_agent_id) id
            FROM print_gateway_runtime_agent_assignment
            WHERE branch_id IS NULL
            ORDER BY company_id, runtime_agent_id, enabled DESC, id ASC
        )
        DELETE FROM print_gateway_runtime_agent_assignment a
        WHERE a.branch_id IS NULL
          AND a.id NOT IN (SELECT id FROM kept)
        """
    )
