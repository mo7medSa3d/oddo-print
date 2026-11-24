#!/usr/bin/env python3
"""Regenerate the WOFF2 web fonts from the pinned TTF sources.

The repository ships three copies of each family:

  src/app/fonts/*.ttf                          the pinned upstream sources
  src/app/fonts/*.woff2                        what the Web app serves
  odoo_addons/print_gateway/static/fonts/*.ttf  what the Odoo add-on serves

The Web app serves WOFF2 (about 65% smaller than the TTF). The Desktop app
and the Odoo add-on serve the TTF: the Desktop app bundles it with the
installer, and the Odoo server's PDF engine reads it from disk.

This script regenerates the WOFF2 files from the TTF sources. It is an asset
authoring step, not a build step: the results are committed, and the digests
are pinned by tests/font-assets.node.test.mjs and
scripts/check-typography-tokens.py.

Requires: fonttools with brotli support.
"""
from __future__ import annotations

import sys
from pathlib import Path

try:
    from fontTools.ttLib import TTFont
except ImportError:  # pragma: no cover - authoring tool, not a runtime path
    print("fonttools is required: pip install 'fonttools[woff]'", file=sys.stderr)
    raise SystemExit(1)

ROOT = Path(__file__).resolve().parent.parent
FONTS = ROOT / "src" / "app" / "fonts"


def main() -> int:
    ttfs = sorted(FONTS.glob("*.ttf"))
    if not ttfs:
        print(f"no TTF sources found in {FONTS}", file=sys.stderr)
        return 1
    for ttf in ttfs:
        font = TTFont(ttf, recalcBBoxes=False, recalcTimestamp=False)
        font.flavor = "woff2"
        target = ttf.with_suffix(".woff2")
        font.save(target, reorderTables=False)
        font.close()
        print(f"{ttf.name} -> {target.name} ({target.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
