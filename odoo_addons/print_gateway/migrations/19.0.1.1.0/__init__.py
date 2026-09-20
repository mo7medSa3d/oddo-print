"""Migration 19.0.1.1.0 for print_gateway.

Odoo 19-specific upgrade migration:
Removes legacy ORM-created constraint names (_sql_constraints) before
new models.Constraint declarations are installed by the Odoo 19 ORM.
This is intentionally separate from 1.1.0, which handles data backfills
and schema modernization for pre-1.1.0 databases.
"""
