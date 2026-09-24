# -*- coding: utf-8 -*-
{
    'name': 'Yasser Print Gateway',
    'version': '19.0.2.8.0',
    'summary': 'Reliable silent printing for Odoo through Yasser Print Gateway',
    'description': """
Yasser Print Gateway connects Odoo with the printers used by your business.

Manage your printing connection, branch devices, print rules, automated printing,
and print activity from Odoo. Documents are sent to the configured printer for
the correct company and branch, while the printing service tracks delivery and
reports the result back to Odoo.

Gateway printing is silent: when a print rule is active, Odoo sends the document
to the printing service without opening the browser print dialog.
    """,
    'author': 'Yasser',
    'website': 'https://github.com/mo7medSa3d/oddo-print',
    'category': 'Tools',
    'depends': ['base', 'web', 'sale', 'account', 'stock', 'purchase', 'point_of_sale'],
    'external_dependencies': {'python': ['requests', 'cryptography']},
    'data': [
        'security/ir.model.access.csv',
        'security/security.xml',
        'views/gateway_config_views.xml',
        'views/binding_views.xml',
        'views/print_policy_views.xml',
        'views/print_job_views.xml',
        'views/print_intent_views.xml',
        'views/runtime_assignment_views.xml',
        'views/menu.xml',
        'data/cron.xml',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'print_gateway/static/src/js/gateway_limit_dialog.js',
            'print_gateway/static/src/js/pos_print_router.js',
            'print_gateway/static/src/js/pos_sale_details_router.js',
        ],
        'web.assets_backend': [
            'print_gateway/static/src/scss/print_gateway_tokens.scss',
            'print_gateway/static/src/scss/print_gateway_backend.scss',
            'print_gateway/static/src/components/runtime_agent_field.js',
            'print_gateway/static/src/components/runtime_printer_field.js',
            'print_gateway/static/src/js/gateway_config_auto_sync.js',
            'print_gateway/static/src/js/gateway_limit_dialog.js',
            'print_gateway/static/src/js/report_interceptor.js',
            'print_gateway/static/src/js/tours/binding_cascade_tour.js',
        ],
    },
    'installable': True,
    'application': True,
    'icon': 'static/description/icon.png',
    'license': 'LGPL-3',
}