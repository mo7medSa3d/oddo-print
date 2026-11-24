"""Preserve print-route order while closing the nullable Branch uniqueness gap.

Odoo 19 creates the model's partial UniqueIndex during module registry update.
Normalize any legacy company-wide duplicate priorities *before* that index is
created. This deliberately does not remove records, move branches, change
destinations, or issue print requests.
"""


def migrate(cr, version):
    if not version:
        return

    cr.execute("""
        SELECT id, company_id, destination_ref, document_type, priority
          FROM print_gateway_binding
         WHERE branch_id IS NULL
           AND destination_ref IS NOT NULL
           AND document_type IS NOT NULL
           AND priority IS NOT NULL
         ORDER BY company_id, destination_ref, document_type, priority, id
    """)
    # Materialize the snapshot before issuing UPDATE statements with the same
    # cursor. The ordering matches _order='priority, id' within each route.
    rows = cr.fetchall()
    current_key = None
    previous_priority = None
    for route_id, company_id, destination_ref, document_type, priority in rows:
        key = (company_id, destination_ref, document_type)
        if key != current_key:
            current_key = key
            previous_priority = priority
            continue
        # Keep existing values unless they would collide. If a duplicate
        # needs +1 and that collides with a subsequent route, shift only that
        # subsequent route too. This preserves the exact former order.
        corrected = max(priority, previous_priority + 1)
        if corrected > 2147483647:
            raise RuntimeError(
                "Cannot normalize company-wide print-route priorities: "
                "integer priority range exhausted for company %s" % company_id
            )
        if corrected != priority:
            cr.execute(
                "UPDATE print_gateway_binding SET priority = %s WHERE id = %s",
                (corrected, route_id),
            )
        previous_priority = corrected
