# -*- coding: utf-8 -*-
"""Backend report interception through the single Print Gateway router."""

from odoo import models, _

from .binding import _assert_report_usage_access


class IrActionsReportGateway(models.Model):
    _inherit = "ir.actions.report"

    def report_action(self, docids, data=None, config=True):
        self.ensure_one()
        # Odoo 19 distinguishes qweb-pdf from qweb-html. The Gateway is a
        # physical-print transport, so only PDF report actions are intercepted;
        # HTML actions must preserve Odoo's native preview/render semantics.
        if self.report_type != "qweb-pdf":
            return super().report_action(docids, data=data, config=config)

        # Preserve Odoo 19's native report-layout configuration gate. The core
        # implementation returns the external-layout configurator for an
        # administrator whose company has no report layout yet. Gateway
        # interception must not bypass that business/UI contract.
        if (
            config
            and self.env.is_admin()
            and not self.env.company.external_report_layout_id
            and not self.env.context.get("discard_logo_check")
        ):
            return super().report_action(docids, data=data, config=config)

        _assert_report_usage_access(self.env, self)
        if getattr(docids, "_name", None) == self.model:
            records = docids.exists()
        else:
            normalized_ids = docids if isinstance(docids, (list, tuple)) else [docids] if docids is not None else []
            records = self.env[self.model].browse(normalized_ids).exists() if normalized_ids else self.env[self.model]
        # Same read authorization as the /report/download controller: when
        # the gateway dispatches a rendered document out of the database
        # perimeter, the caller must be allowed to read every source record.
        # Native Odoo rendering below is already ACL-protected; this closes
        # the gateway-dispatch side of the same action.
        if records:
            records.check_access("read")
        router = self.env["print_gateway.print_router"]

        route = router.route_report(self, records, data=data)
        if not route.get("native"):
            status = route.get("status")
            accepted = status in ("queued", "submitted", "claimed", "printing", "success")
            # A successful RPC is not proof of spooler acceptance or paper
            # output. Match the frontend allowlist; unknown/malformed outcomes
            # must never inherit the router's generic "accepted" message.
            message = route.get("message") if accepted else (
                _("Gateway print failed for bound printer. Native download cancelled.")
                if status == "failed" else
                _("Print status is unknown. Check the printer before trying again.")
            )
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {
                    "title": _("Print Job Accepted") if accepted else _("Printing Service"),
                    "message": message,
                    "type": "success" if accepted else "danger" if status == "failed" else "warning",
                    "sticky": not accepted,
                },
            }
        return super().report_action(docids, data=data, config=config)
