#!/usr/bin/env python3
"""Fail closed when the shared typography system drifts.

One definition, three consumers:

  typography/tokens.css                                     (canonical)
  odoo_addons/print_gateway/static/src/css/typography_tokens.css   (Odoo copy)

The Odoo add-on is installed as a standalone module, so it cannot import a
file from outside the module. It therefore ships a copy, and this check makes
the copy provably identical to the canonical file instead of letting the two
drift apart silently.

The check also pins the values themselves: the type scale, the families, the
line heights and the contrast colours are a specification, not a preference, so
an edit that changes one of them must fail here until the specification is
changed deliberately.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

CANONICAL_TOKENS = ROOT / "typography" / "tokens.css"
ODOO_TOKENS = ROOT / "odoo_addons" / "print_gateway" / "static" / "src" / "css" / "typography_tokens.css"
ODOO_FONTS_DIR = ROOT / "odoo_addons" / "print_gateway" / "static" / "fonts"
WEB_FONTS_DIR = ROOT / "src" / "app" / "fonts"

FONT_FILES = (
    "ibm-plex-sans-variable.ttf",
    "ibm-plex-sans-arabic-400.ttf",
    "ibm-plex-sans-arabic-500.ttf",
    "ibm-plex-sans-arabic-600.ttf",
    "ibm-plex-sans-arabic-700.ttf",
)

# The specification. Values are the exact strings the tokens must declare.
REQUIRED_TOKENS = {
    "--typo-font-latin": 'var(--font-thmanyah, "Thmanyah Sans"), var(--font-ibm-plex-sans, "IBM Plex Sans")',
    "--typo-font-arabic": 'var(--font-thmanyah, "Thmanyah Sans"), var(--font-ibm-plex-sans-arabic, "IBM Plex Sans Arabic")',
    "--typo-weight-regular": "400",
    "--typo-weight-medium": "500",
    "--typo-weight-semibold": "600",
    "--typo-weight-bold": "700",
    "--typo-fs-display": "20pt",
    "--typo-fs-section": "14pt",
    "--typo-fs-body": "10.5pt",
    "--typo-fs-emphasis": "11pt",
    "--typo-fs-label": "8.5pt",
    "--typo-fs-footer": "8pt",
    "--typo-lh-arabic": "1.6",
    "--typo-lh-latin": "1.4",
    "--typo-lh-mixed": "1.5",
    "--typo-space-table-row": "4pt",
    "--typo-color-primary": "#111827",
    "--typo-color-secondary": "#4B5563",
}

# Screen equivalents are pt x 1.333. The tolerance absorbs the rounding of a
# 3-decimal px value; a real scale change moves far outside it.
PX_EQUIVALENTS = {
    "--typo-fs-display-px": (20 * 1.333, 0.01),
    "--typo-fs-section-px": (14 * 1.333, 0.01),
    "--typo-fs-body-px": (10.5 * 1.333, 0.01),
    "--typo-fs-emphasis-px": (11 * 1.333, 0.01),
    "--typo-fs-label-px": (8.5 * 1.333, 0.01),
    "--typo-fs-footer-px": (8 * 1.333, 0.01),
}

FALLBACK_STACK = ['"Noto Sans Arabic"', '"Noto Sans"', "Tahoma", "Arial", "sans-serif"]


def fail(message: str) -> None:
    print(f"typography check FAILED: {message}", file=sys.stderr)
    raise SystemExit(1)


def token_value(source: str, name: str) -> str | None:
    # Not anchored to a line start: the pt and px members of one scale step may
    # share a line. The name must be followed by ":" so "--typo-fs-display"
    # never matches "--typo-fs-display-px".
    match = re.search(rf"(?<![\w-]){re.escape(name)}\s*:\s*([^;]+);", source)
    return match.group(1).strip() if match else None


def check_tokens_file(path: Path, label: str) -> str:
    if not path.is_file():
        fail(f"{label} is missing: {path}")
    source = path.read_text(encoding="utf-8")
    for name, expected in REQUIRED_TOKENS.items():
        actual = token_value(source, name)
        if actual is None:
            fail(f"{label} does not declare {name}")
        if actual != expected:
            fail(f"{label} declares {name}: {actual!r}, expected {expected!r}")
    for name, (expected_px, tolerance) in PX_EQUIVALENTS.items():
        actual = token_value(source, name)
        if actual is None:
            fail(f"{label} does not declare {name}")
        try:
            value = float(actual.rstrip("px").strip())
        except ValueError:
            fail(f"{label} declares {name}: {actual!r}, which is not a px length")
        if abs(value - expected_px) > tolerance:
            fail(f"{label} declares {name}: {actual!r}, expected ~{expected_px:.3f}px (pt x 1.333)")
    # The stack must carry both faces and the full fallback tail. The
    # direction-aware orderings are checked separately: both faces carry
    # Latin glyphs, so the ORDER decides which one renders English text.
    fallbacks = token_value(source, "--typo-font-fallbacks")
    if fallbacks is None:
        fail(f"{label} does not declare --typo-font-fallbacks")
    for family in FALLBACK_STACK:
        if family not in fallbacks:
            fail(f"{label} --typo-font-fallbacks is missing {family}")
    for name, expected_lead in (
        ("--typo-font-stack", "--typo-font-arabic"),
        ("--typo-font-stack-arabic", "--typo-font-arabic"),
        ("--typo-font-stack-latin", "--typo-font-latin"),
    ):
        stack = token_value(source, name)
        if stack is None:
            fail(f"{label} does not declare {name}")
        if not stack.startswith(f"var({expected_lead})"):
            fail(f"{label} {name} must lead with {expected_lead}, got {stack!r}")
        if "var(--typo-font-fallbacks)" not in stack:
            fail(f"{label} {name} must end with the shared fallback list")
    if '"IBM Plex Sans Arabic"' not in (token_value(source, "--typo-font-arabic") or ""):
        fail(f"{label} --typo-font-arabic must name IBM Plex Sans Arabic")
    if '"IBM Plex Sans"' not in (token_value(source, "--typo-font-latin") or ""):
        fail(f"{label} --typo-font-latin must name IBM Plex Sans")
    return source


def main() -> int:
    canonical = check_tokens_file(CANONICAL_TOKENS, "typography/tokens.css")
    odoo = check_tokens_file(ODOO_TOKENS, "the Odoo token copy")

    if canonical != odoo:
        fail(
            "the Odoo token copy differs from typography/tokens.css. "
            "The add-on ships a standalone copy, so it must be byte-identical."
        )

    for name in FONT_FILES:
        web = WEB_FONTS_DIR / name
        odoo_font = ODOO_FONTS_DIR / name
        if not web.is_file():
            fail(f"the web font file is missing: {web}")
        if not odoo_font.is_file():
            fail(f"the Odoo font file is missing: {odoo_font}")
        if web.read_bytes() != odoo_font.read_bytes():
            fail(f"the Odoo copy of {name} differs from the web font file")
        # The Web app serves WOFF2; the Desktop app and the Odoo add-on serve
        # the TTF. The WOFF2 payload is generated from the TTF by
        # scripts/build-web-fonts.py and its digest is pinned in
        # tests/font-assets.node.test.mjs.
        woff2 = WEB_FONTS_DIR / name.replace(".ttf", ".woff2")
        if not woff2.is_file():
            fail(f"the web WOFF2 payload is missing: {woff2}")
        if woff2.read_bytes()[:4] != b"wOF2":
            fail(f"the web WOFF2 payload has a bad signature: {woff2}")

    print(f"typography check OK: canonical tokens, Odoo copy and {len(FONT_FILES)} font files agree")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
