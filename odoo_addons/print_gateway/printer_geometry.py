"""Strict, side-effect-free reader for the shared printer geometry v1 contract.

Only the Agent reports measurements. Odoo never infers printable dots from a
nominal roll width, printer name, protocol label, or browser defaults.
"""
from datetime import datetime
import math
import re


MIN_RECEIPT_PAPER_WIDTH_MM = 40.0
MAX_RECEIPT_PAPER_WIDTH_MM = 120.0

_EXPECTED_VALIDATION = {
    "windows_driver": "observed",
    "ipp": "observed",
    "validated_profile": "configured",
}
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_FINGERPRINT_RE = re.compile(r"[0-9a-f]{64}")
_OBSERVED_AT_RE = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z")
_CORE_KEYS = ("version", "source", "validation", "observed_at", "printer_id", "config_fingerprint")
_INTEGER_FIELDS = (
    ("printable_width_dots", 1, 16384),
    ("printable_height_dots", 1, 1000000),
    ("dpi_x", 1, 9600),
    ("dpi_y", 1, 9600),
    ("offset_x_dots", 0, 1000000),
    ("offset_y_dots", 0, 1000000),
)
_PAPER_MM_KEYS = ("paper_width_mm", "paper_height_mm")
_ALLOWED_KEYS = frozenset(
    (*_CORE_KEYS, *(key for key, _, _ in _INTEGER_FIELDS), *_PAPER_MM_KEYS, "raster_command")
)
_AXIS_BOUNDS = (
    ("paper_width_mm", "dpi_x", "printable_width_dots", "offset_x_dots"),
    ("paper_height_mm", "dpi_y", "printable_height_dots", "offset_y_dots"),
)


def normalize_receipt_paper_width_mm(value):
    """Normalize a declared receipt-roll width without guessing a printer size.

    Printer inventory historically reports integral widths as either JSON
    integers or floats (for example 58 and 58.0). Custom roll widths such as
    79 or 79.5 mm are valid too; do not restrict real media to two nominal
    marketing sizes. This helper is for the optional roll-width hint and
    diagnostic PDF page only. POS raster admission still requires a complete,
    identity-bound geometry snapshot.
    """
    if type(value) not in (int, float):
        return None
    try:
        width = float(value)
    except (OverflowError, TypeError, ValueError):
        return None
    if not math.isfinite(width) or not MIN_RECEIPT_PAPER_WIDTH_MM <= width <= MAX_RECEIPT_PAPER_WIDTH_MM:
        return None
    return int(width) if width.is_integer() else width


def validated_printer_geometry(value, printer_id=None, fingerprint=None):
    if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1:
        return None
    source = value.get("source")
    if source not in _EXPECTED_VALIDATION or value.get("validation") != _EXPECTED_VALIDATION[source]:
        return None
    identity = value.get("printer_id")
    # Geometry cannot authorize a printer identity the Gateway and Go Agent
    # cannot execute. Their opaque ID boundary is 120 UTF-8 bytes, not
    # Python characters or UTF-16 units. Never trim or repair an identifier.
    if (not isinstance(identity, str) or not identity or len(identity) > 120
            or identity != identity.strip()
            or identity.startswith("\ufeff") or identity.endswith("\ufeff")
            or _CONTROL_CHAR_RE.search(identity)
            or (printer_id is not None and identity != printer_id)):
        return None
    try:
        if len(identity.encode("utf-8", "strict")) > 120:
            return None
    except UnicodeEncodeError:
        return None
    actual_fingerprint = value.get("config_fingerprint")
    if (not isinstance(actual_fingerprint, str) or not _FINGERPRINT_RE.fullmatch(actual_fingerprint)
            or (fingerprint is not None and actual_fingerprint != fingerprint)):
        return None
    observed_at = value.get("observed_at")
    if not isinstance(observed_at, str) or not _OBSERVED_AT_RE.fullmatch(observed_at):
        return None
    try:
        datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    if not _ALLOWED_KEYS.issuperset(value):
        return None
    if "printable_width_dots" not in value:
        return None
    result = {key: value[key] for key in _CORE_KEYS}
    for key, minimum, maximum in _INTEGER_FIELDS:
        if key in value:
            number = value[key]
            if type(number) is not int or not minimum <= number <= maximum:
                return None
            result[key] = number
    for key in _PAPER_MM_KEYS:
        if key in value:
            number = value[key]
            if type(number) not in (int, float) or not 0 < number <= 10000 or not math.isfinite(number):
                return None
            result[key] = number
    if "raster_command" in value:
        if value["raster_command"] != "gs_v_0":
            return None
        result["raster_command"] = "gs_v_0"
    for size, dpi, printable, offset in _AXIS_BOUNDS:
        if size in result and dpi in result and printable in result:
            if result[printable] + result.get(offset, 0) > result[size] * result[dpi] / 25.4 + 1:
                return None
    return result


def validated_receipt_geometry(value, printer_id=None):
    result = validated_printer_geometry(value, printer_id)
    if result is None or "dpi_x" not in result or "dpi_y" not in result:
        return None
    return result
