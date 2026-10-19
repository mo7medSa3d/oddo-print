# -*- coding: utf-8 -*-
from . import pos
from . import runtime_printers

# Odoo 19 report actions are intercepted by the supported web-client action
# service patch in static/src/js/report_interceptor.js.  Do not register the
# legacy /report/download controller contract: leaving the native controller
# untouched preserves Odoo's complete URL query, data, context, and fallback.
