"""Restore deterministic intent ownership before the ORM adds NOT NULL."""


def migrate(cr, version):
    if not version:
        return
    cr.execute("SELECT to_regclass('print_gateway_intent')")
    if not cr.fetchone()[0]:
        return

    cr.execute("""
        UPDATE print_gateway_intent AS i
           SET company_id = j.company_id
          FROM print_gateway_print_job AS j
         WHERE i.company_id IS NULL AND j.id = i.print_job_id
           AND j.company_id IS NOT NULL
    """)
    cr.execute("""
        WITH owners AS (
            SELECT 'account.move' AS res_model, id, company_id FROM account_move
            UNION ALL
            SELECT 'stock.picking', id, company_id FROM stock_picking
            UNION ALL
            SELECT 'sale.order', id, company_id FROM sale_order
            UNION ALL
            SELECT 'purchase.order', id, company_id FROM purchase_order
            UNION ALL
            SELECT 'pos.order', id, company_id FROM pos_order
        )
        UPDATE print_gateway_intent AS i
           SET company_id = o.company_id
          FROM owners AS o
         WHERE i.company_id IS NULL AND i.res_model = o.res_model
           AND i.res_id = o.id AND o.company_id IS NOT NULL
    """)
    # A company-wide policy can match branch records; it cannot prove ownership.
    cr.execute("SELECT id FROM print_gateway_intent WHERE company_id IS NULL ORDER BY id LIMIT 20")
    unresolved = [row[0] for row in cr.fetchall()]
    if unresolved:
        raise RuntimeError(
            "Migration blocked: print intents have no provable company (ids=%s). "
            "Restore their source record or set their verified company before upgrading; "
            "automatic policy/default-company assignment is forbidden." % unresolved
        )
