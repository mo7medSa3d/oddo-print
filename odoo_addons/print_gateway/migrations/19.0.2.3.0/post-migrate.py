from odoo import api, SUPERUSER_ID


def migrate(cr, version):
    if not version:
        return

    env = api.Environment(cr, SUPERUSER_ID, {})
    table = env["print_gateway.runtime_agent_assignment"]._table

    # Prior releases enforced one Agent per branch. The new contract permits
    # multiple distinct Agents per branch while keeping duplicate assignments
    # impossible. Odoo normally names this generated SQL constraint from the
    # table and columns; both names are dropped defensively for upgrades from
    # slightly different schema generations.
    cr.execute(
        "ALTER TABLE %s DROP CONSTRAINT IF EXISTS %s" % (
            table,
            table + "_company_id_branch_id_key",
        )
    )
    cr.execute(
        "ALTER TABLE %s DROP CONSTRAINT IF EXISTS %s" % (
            table,
            table + "_company_id_branch_id_uniq",
        )
    )

    # A company-level assignment is represented by branch_id IS NULL, never
    # by pointing branch_id back to the root company.
    cr.execute(
        "UPDATE %s SET branch_id = NULL WHERE branch_id = company_id" % table
    )

    cr.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS %s ON %s (company_id, branch_id, runtime_agent_id)" % (
            table + "_company_branch_agent_uniq",
            table,
        )
    )
