"""Remove retired menu/action records from installed Odoo 19 databases.

Odoo does not delete old XML records merely because they disappeared from a
module's data files. Do this on upgrade; preserve user-created submenus and all
stored company/branch printer assignments, print routes, jobs and history.
"""
from odoo import SUPERUSER_ID, api


def migrate(cr, version):
    if not version:
        return
    env = api.Environment(cr, SUPERUSER_ID, {})
    root = env.ref("print_gateway.menu_print_gateway_main", raise_if_not_found=False)
    def retire_menu(xmlid):
        menu = env.ref(xmlid, raise_if_not_found=False)
        if not menu or not menu.exists():
            return
        # Odoo unlinks a menu by detaching its children; the old Printers
        # menu can contain custom/inactive third-party children too.
        children = env["ir.ui.menu"].with_context(active_test=False).search([
            ("parent_id", "=", menu.id),
        ])
        if children:
            if not root or not root.exists() or root.id == menu.id:
                raise RuntimeError("Cannot preserve legacy Yaseir submenus without a root menu")
            children.write({"parent_id": root.id})
        menu.unlink()

    retire_menu("print_gateway.menu_print_gateway_advanced")
    retire_menu("print_gateway.menu_print_gateway_printers")
    old_action = env.ref("print_gateway.action_print_gateway_printers", raise_if_not_found=False)
    if old_action and old_action.exists():
        old_action.unlink()
