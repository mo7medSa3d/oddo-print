# -*- coding: utf-8 -*-
"""Odoo POS HTTP boundaries that bypass ``report_action``."""

import json

from odoo import http
from odoo.http import request
from odoo.addons.point_of_sale.controllers.main import PosController


class PrintGatewayPosController(PosController):
    """Intercept the verified direct Sale Details report route.

    This HTTP report/export path resolves an ``ir.actions.report`` binding.
    Odoo 19's in-session Sale Details button is different: it renders a receipt
    element in the POS and uses the POS receipt printer, so the Gateway POS
    patch routes that path through the POS config's ``receipt`` binding.
    """

    @http.route('/pos/sale_details_report', type='http', auth='user')
    def print_sale_details(self, date_start=False, date_stop=False, **kw):
        gateway = request.env['print_gateway.print_router']._gateway_config(request.env.company)
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
        if result.get('native'):
            return request.make_response(
                json.dumps({
                    'error': 'gateway_binding_missing',
                    'message': request.env._('Gateway printing is enabled, but no Sale Details binding is configured for this POS.'),
                }),
                headers=[('Content-Type', 'application/json'), ('Cache-Control', 'no-store')],
                status=422,
            )
        response = request.make_response(
            json.dumps(result, default=str),
            headers=[
                ('Content-Type', 'application/json'),
                ('Cache-Control', 'no-store'),
            ],
        )
        # Use 202 for accepted (queued) jobs, 200 for completed/synchronous results
        response.status_code = 202 if result.get('status') in ('queued', 'claimed', 'printing') else 200
        return response
