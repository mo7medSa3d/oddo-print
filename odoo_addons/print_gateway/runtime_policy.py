"""Direct Odoo Agent identity validation.

These checks validate opaque identifiers only. Printer health and optional
capability observations must never be used as a generic dispatch gate.
"""

import re

_AGENT_UID_PATTERN = re.compile(r"agt_[A-Za-z0-9_-]{8}\Z")


def is_exact_agent_uid(value):
    """Accept only the exact Agent UID issued by this Odoo database."""
    return isinstance(value, str) and _AGENT_UID_PATTERN.fullmatch(value) is not None


def is_exact_printer_key(value):
    """Preserve a printer's exact local key; never normalize it into another target."""
    if (not isinstance(value, str) or not value or value != value.strip()
            or value.startswith("\ufeff") or value.endswith("\ufeff")):
        return False
    if any(ord(ch) < 32 or 127 <= ord(ch) <= 159 for ch in value):
        return False
    try:
        return len(value.encode("utf-8", "strict")) <= 120
    except UnicodeEncodeError:
        return False
