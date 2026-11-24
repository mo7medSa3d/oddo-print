"""Refresh this addon's approved Arabic copy during the V3-to-V4 upgrade."""

from odoo import api, SUPERUSER_ID


def migrate(cr, version):
    if not version:
        return
    env = api.Environment(cr, SUPERUSER_ID, {})
    languages = env["res.lang"].search([
        ("active", "=", True), ("code", "=like", "ar_%"),
    ]).mapped("code")
    if languages:
        # Odoo otherwise preserves an existing translation for an unchanged
        # English msgid (e.g. Connection), leaving old V3 labels after upgrade.
        # Restrict replacement to print_gateway and active Arabic variants.
        env["ir.module.module"].search([("name", "=", "print_gateway")])._update_translations(
            languages, overwrite=True,
        )
