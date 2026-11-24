# -*- coding: utf-8 -*-
{
    'name': 'Yaseir Print Gateway',
    'version': '20.0.2.37.0',
    'summary': 'Connect Odoo to Yaseir printers with company and branch routing',
    'description': """
Connect Odoo to Yaseir once per company.

Assign a printing computer to each company or branch. Select a printer
for each print source under Print Routing. Enable automatic printing
only when the relevant print rules are ready.

Computer assignments are managed in one place. Selecting a printer does not
create an agent assignment or send a print job.
    """,
    'author': 'Yaseir',
    'website': 'https://print.yaseir.cloud/',
    'category': 'Tools',
    'depends': ['base', 'web', 'sale', 'account', 'stock', 'purchase', 'point_of_sale'],
    'external_dependencies': {'python': ['requests', 'cryptography']},
    'data': [
        'security/ir.access.csv',
        'views/print_service_views.xml',
        'views/binding_views.xml',
        'views/print_policy_views.xml',
        'views/print_job_views.xml',
        'views/print_intent_views.xml',
        'views/runtime_assignment_views.xml',
        'views/agent_views.xml',
        'views/menu.xml',
        'data/cron.xml',
    ],
    'demo': [],
    'assets': {
        'point_of_sale._assets_pos': [
            'print_gateway/static/src/js/async_control.js',
            'print_gateway/static/src/js/operation_recovery.js',
            'print_gateway/static/src/js/gateway_limit_dialog.js',
            'print_gateway/static/src/css/receipt_raster.css',
            'print_gateway/static/src/js/printer_geometry.js',
            'print_gateway/static/src/js/receipt_raster.js',
            'print_gateway/static/src/js/pos_print_router.js',
            'print_gateway/static/src/js/pos_sale_details_router.js',
        ],
        'web.assets_backend': [
            'print_gateway/static/src/css/typography_tokens.css',
            'print_gateway/static/src/css/typography_fonts.css',
            'print_gateway/static/src/scss/print_gateway_tokens.scss',
            'print_gateway/static/src/js/async_control.js',
            'print_gateway/static/src/js/printer_geometry.js',
            'print_gateway/static/src/js/printer_verification.js',
            'print_gateway/static/src/js/operation_recovery.js',
            'print_gateway/static/src/scss/print_gateway_backend.scss',
            'print_gateway/static/src/components/runtime_agent_field.js',
            'print_gateway/static/src/components/runtime_printer_field.js',
            'print_gateway/static/src/components/language_switcher.js',
            'print_gateway/static/src/components/language_switcher.xml',
            'print_gateway/static/src/js/gateway_limit_dialog.js',
            'print_gateway/static/src/js/report_interceptor.js',
        ],
        # Regression tours are available only with Odoo's debug=tests asset
        # mode, never in the ordinary customer-facing backend bundle.
        'web.assets_tests': [
            'print_gateway/static/src/js/tours/binding_cascade_tour.js',
        ],
    },
    'post_init_hook': 'post_init_hook',
    'uninstall_hook': 'uninstall_hook',
    'installable': True,
    'application': True,
    'icon': '/print_gateway/static/description/icon.png',
    'license': 'LGPL-3',
}
