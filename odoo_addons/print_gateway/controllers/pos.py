# -*- coding: utf-8 -*-
"""Odoo POS HTTP boundaries that bypass ``report_action``."""

import json
import logging

from odoo import http
from odoo.http import request
from odoo.addons.point_of_sale.controllers.main import PosController

_logger = logging.getLogger(__name__)


class PrintGatewayPosController(PosController):
    """Intercept the verified direct Sale Details report route.

    This HTTP report/export path resolves an ``ir.actions.report`` binding.
    Odoo 19's in-session Sale Details button is different: it renders a receipt
    element in the POS and uses the POS receipt printer, so the Gateway POS
    patch routes that path through the POS config's ``receipt`` binding.
    """

    @http.route('/pos/sale_details_report', type='http', auth='user', methods=['GET', 'HEAD', 'POST'], csrf=True)
    def print_sale_details(self, date_start=False, date_stop=False, **kw):
        # The native Odoo endpoint is a safe PDF GET. A link, preload, or
        # cross-site navigation must never submit a physical print job.
        # Odoo's authenticated POST request carries the standard CSRF token.
        if request.httprequest.method != 'POST':
            return super().print_sale_details(date_start=date_start, date_stop=date_stop, **kw)
        try:
            gateway = request.env['print_gateway.print_router']._print_config(request.env.company)
            if not gateway:
                return super().print_sale_details(date_start=date_start, date_stop=date_stop, **kw)

            render_target = request.env['report.point_of_sale.report_saledetails']
            result = request.env['print_gateway.print_router'].route_render_target(
                'point_of_sale.sale_details_report',
                render_target,
                company=request.env.company,
                document_type='report:point_of_sale.sale_details_report',
                context_values={'date_start': date_start, 'date_stop': date_stop},
            )
        except Exception:
            # POS fault tolerance: license, verification, or sync failures must
            # never block or break Sale Details printing. Log clearly and degrade
            # to Odoo's native PDF download.
            _logger.warning(
                "Direct POS Sale Details routing degraded to native PDF fallback",
                exc_info=True,
            )
            return super().print_sale_details(date_start=date_start, date_stop=date_stop, **kw)
        if result.get('native'):
            # No Sale Details binding: preserve Odoo's native PDF download
            # exactly like the disabled path above. An enabled gateway without
            # a binding must not turn a working document into a hard error.
            return super().print_sale_details(date_start=date_start, date_stop=date_stop, **kw)
        response = request.make_response(
            json.dumps(result, default=str),
            headers=[
                ('Content-Type', 'application/json; charset=utf-8'),
                ('Cache-Control', 'no-store'),
                ('X-Content-Type-Options', 'nosniff'),
            ],
        )
        # Gateway acceptance is asynchronous (including 'submitted'); a
        # 200 response must not falsely signal synchronous completion.
        response.status_code = 202 if result.get('status') in ('queued', 'claimed', 'printing') else 200
        return response
