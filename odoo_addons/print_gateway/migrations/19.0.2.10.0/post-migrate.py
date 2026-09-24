from odoo import SUPERUSER_ID


def migrate(cr, version):
    if not version:
        return

    # Report bindings historically had two report fields. The physical route
    # was derived from destination_report_id while document_type came from
    # report_id, so mismatched rows could silently route one report using the
    # metadata of another. Version 2.10 makes report_id the single
    # operator-facing authority and preserves the pre-upgrade route by copying
    # destination_report_id into report_id when it exists.
    cr.execute(
        """
        UPDATE print_gateway_binding AS b
           SET report_id = b.destination_report_id,
               destination_ref = 'ir.actions.report,' || b.destination_report_id::text,
               document_type = CASE
                   WHEN r.model = 'sale.order' THEN 'order'
                   WHEN r.model = 'account.move' THEN 'invoice'
                   WHEN r.model = 'stock.picking' THEN 'delivery'
                   WHEN r.model = 'purchase.order' THEN 'purchase_order'
                   WHEN r.model = 'pos.order' THEN 'receipt'
                   ELSE 'report:' || COALESCE(NULLIF(lower(trim(r.report_name)), ''), r.id::text)
               END
          FROM ir_actions_report AS r
         WHERE b.destination_type = 'report'
           AND b.destination_report_id IS NOT NULL
           AND r.id = b.destination_report_id
           AND b.report_id IS DISTINCT FROM b.destination_report_id
        """
    )

    # Be defensive for rows created through older RPC/import paths that have
    # report_id but no destination_report_id. They are valid under the new
    # model and need their stored computed routing keys refreshed as well.
    cr.execute(
        """
        UPDATE print_gateway_binding AS b
           SET destination_ref = 'ir.actions.report,' || b.report_id::text,
               document_type = CASE
                   WHEN r.model = 'sale.order' THEN 'order'
                   WHEN r.model = 'account.move' THEN 'invoice'
                   WHEN r.model = 'stock.picking' THEN 'delivery'
                   WHEN r.model = 'purchase.order' THEN 'purchase_order'
                   WHEN r.model = 'pos.order' THEN 'receipt'
                   ELSE 'report:' || COALESCE(NULLIF(lower(trim(r.report_name)), ''), r.id::text)
               END
          FROM ir_actions_report AS r
         WHERE b.destination_type = 'report'
           AND b.report_id IS NOT NULL
           AND r.id = b.report_id
           AND (
               b.destination_report_id IS NULL
               OR b.destination_ref IS DISTINCT FROM 'ir.actions.report,' || b.report_id::text
           )
        """
    )
