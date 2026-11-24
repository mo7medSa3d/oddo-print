# -*- coding: utf-8 -*-
"""Locale-aware customer presentation; never changes admission or retry policy.

Stored worker diagnostics remain evidence. They are classified here and never
interpolated into customer text. Pass the current reader's ``env._`` so cron's
language, a previous administrator's language and raw remote errors cannot leak
into the interface. There is deliberately no import-time translation cache.
"""


def job_customer_state(status, physical_outcome):
    if status == "queued":
        return "waiting"
    if status in ("claimed", "printing"):
        return "processing"
    if status == "success":
        return "sent_to_printer"
    if status == "canceled":
        # v4: a queued-cancel is proven not printed; a claimed-cancel is
        # unknown and needs review. The badge/decoration for
        # failed_before_output vs needs_review follows from this.
        return "failed_before_output" if physical_outcome == "not_printed" else "needs_review"
    if status == "failed" and physical_outcome == "not_printed":
        return "failed_before_output"
    return "needs_review"


def customer_error_category(value=None, *, code=None, status=None):
    # Bound processing of historical diagnostics. Only the chosen category,
    # never these strings, is returned or translated.
    # A known Cloud license machine code is stronger evidence than arbitrary
    # diagnostic prose. Billing-denied operations never reached a printer;
    # misleading UNKNOWN_ text must not turn them into physical ambiguities.
    stable_code = str(code or "").upper()
    if stable_code in ("PRINT_QUOTA_EXCEEDED", "MAX_PRINTS_PER_PERIOD"):
        return "quota"
    if stable_code in (
        "TENANT_SUBSCRIPTION_REQUIRED", "TENANT_SUSPENDED",
        "TENANT_DELETED", "TENANT_ENTITLEMENT_UNAVAILABLE",
    ):
        return "subscription"
    raw_upper = str(value or "")[:4000].upper()
    text = f"{stable_code} {raw_upper}"
    if any(token in text for token in ("UNKNOWN_", "UNCERTAIN", "PARTIAL_DELIVERY", "AMBIGUOUS")):
        return "uncertain"
    if raw_upper.startswith((
        "PRINT_RULE_CHANGED:", "PRINT_RULE_NOT_MATCHED:", "PRINT_SOURCE_COMPANY_CHANGED:",
    )):
        return "routing_changed"
    if "PRINT_REJECTED_STALE_POS_OPERATION" in text:
        return "stale_pos"
    if "PRINT_REJECTED_BILLING_HOLD" in text:
        return "billing_receipt"
    if "PRINT_QUOTA_EXCEEDED" in text or "MAX_PRINTS_PER_PERIOD" in text:
        return "quota"
    if any(token in text for token in ("SUBSCRIPTION", "TENANT_SUSPENDED", "TENANT_DELETED", "TENANT_ENTITLEMENT_UNAVAILABLE")):
        return "subscription"
    if status == 401 or any(token in text for token in ("API_KEY", "CREDENTIAL", "UNAUTHORIZED", "INVALIDHEADER")):
        return "credential"
    if any(token in text for token in ("VERIFICATION", "UNVERIFIED", "DEVICE_NOT_APPROVED")):
        return "verification"
    if any(token in text for token in ("PRINTER_OFFLINE", "AGENT_OFFLINE", "PRINTER_NOT_FOUND", "PRINTER_UNAVAILABLE", "PRINTER_NOT_AVAILABLE_TO_ODOO")):
        return "printer"
    if status == 429 or any(token in text for token in ("QUEUE_FULL", "RATE_LIMIT", "MAX_CONCURRENT_JOBS", "MAX_JOBS_PER_MINUTE")):
        return "busy"
    if any(token in text for token in ("REDIRECT", "LICENSE_SERVER_ORIGIN", "LICENSE SERVER URL")):
        return "address"
    if status == 503 or any(token in text for token in ("CONNECTION_ERROR", "CONNECTIONERROR", "TIMED OUT", "TIMEOUT", "COULD NOT REACH")):
        return "connection"
    if status == 403 or any(token in text for token in ("ACCESSERROR", "PERMISSION", "FORBIDDEN")):
        return "permission"
    return "operation"


def customer_error_message(_, value=None, *, code=None, status=None):
    if not value and not code and status is None:
        return ""
    category = customer_error_category(value, code=code, status=status)
    if category == "uncertain":
        return _("The print result needs review. Check the printer before starting another print to avoid duplicate output.")
    if category == "routing_changed":
        return _("The print rule or source company changed after this event. No print was sent. Ask an administrator to review the route and submit a new request if needed.")
    if category == "stale_pos":
        return _("This old POS ticket was not sent. Review the sale and explicitly reprint only if needed.")
    if category == "billing_receipt":
        return _("The receipt was not printed because the subscription blocked it. After renewal, choose an explicit reprint only if still needed.")
    if category == "quota":
        return _("The current monthly print allowance has been used. Wait for the next UTC reset or contact the workspace owner.")
    if category == "subscription":
        return _("Printing is not active for this workspace. Ask the workspace owner to review its subscription in Yaseir.")
    if category == "credential":
        return _("The connection key is not accepted. Create a replacement in Connect Odoo, save it here, and check the connection.")
    if category == "verification":
        return _("The Agent cannot use this printer yet. Check the local printer setup and declared protocol.")
    if category == "printer":
        return _("The selected printer is unavailable from its assigned Agent. Check the Agent computer and printer connection.")
    if category == "busy":
        return _("The printing service is busy. Wait a moment and check Print Activity before trying again.")
    if category == "address":
        return _("Check the connection address. Use the secure address shown in Connect Odoo, without an API path or redirect.")
    if category == "connection":
        return _("The Odoo server or assigned Agent could not be reached. Check their network connection and Print Activity before retrying.")
    if category == "permission":
        return _("You do not have permission for this printing action. Ask your company administrator to review access.")
    return _("This printing action could not be completed. Review the connection, selected printer and Print Activity. Contact your administrator if the problem continues.")
