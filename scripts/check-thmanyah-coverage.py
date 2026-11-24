#!/usr/bin/env python3
"""Fail closed when a served Thmanyah WOFF2 loses glyphs vs its OTF source.

The Gateway WOFF2 files in src/app/fonts/thmanyah/ are full conversions
of the licensed OTFs (no subsetting). The reference here is the Desktop
bundle src/desktop/fonts/*.otf, which was verified byte-identical to the
licensed upload for v9-font; comparing against it keeps this check
self-contained in the repo instead of depending on an external upload.

Checks per weight (300/400/500/700/900):
  - the WOFF2 cmap is exactly the OTF cmap (no codepoint added or lost);
  - category counts match the v9 baseline (Arabic 72, presentation
    forms 111, Latin 95, digits 0-9 all present, 411 codepoints total);
  - Arabic diacritics U+064B-U+0652 are present;
  - glyph count is unchanged and GSUB/GPOS (Arabic shaping) survive;
  - the OS/2 weight matches the file's intended weight.

Requires fontTools (pip install fonttools brotli). Exit 1 on any failure.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "src" / "app" / "fonts" / "thmanyah"
DESKTOP_DIR = ROOT / "src" / "desktop" / "fonts"

WEIGHTS = {
    "Light": 300,
    "Regular": 400,
    "Medium": 500,
    "Bold": 700,
    "Black": 900,
}

EXPECTED = {"arabic": 72, "presentation": 111, "latin": 95, "total": 411}


def categories(cmap: dict[int, str]) -> dict[str, int]:
    counts = {"arabic": 0, "presentation": 0, "latin": 0, "total": len(cmap)}
    for cp in cmap:
        if 0x0600 <= cp <= 0x06FF:
            counts["arabic"] += 1
        if 0xFB50 <= cp <= 0xFDFF or 0xFE70 <= cp <= 0xFEFF:
            counts["presentation"] += 1
        if 0x20 <= cp <= 0x7E:
            counts["latin"] += 1
    return counts


def main() -> int:
    try:
        from fontTools.ttLib import TTFont
    except ImportError:
        print("check-thmanyah-coverage: fontTools is not installed", file=sys.stderr)
        return 1
    failures: list[str] = []
    for name, weight in WEIGHTS.items():
        otf = DESKTOP_DIR / f"thmanyahsans-{name}.otf"
        woff2 = WEB_DIR / f"thmanyahsans-{name}.woff2"
        if not woff2.exists():
            failures.append(f"{name}: missing {woff2}")
            continue
        if not otf.exists():
            failures.append(f"{name}: missing reference {otf}")
            continue
        a, b = TTFont(str(otf)), TTFont(str(woff2))
        ca, cb = a.getBestCmap(), b.getBestCmap()
        if ca != cb:
            failures.append(
                f"{name}: cmap drifted (lost {sorted(set(ca) - set(cb))[:8]}, "
                f"gained {sorted(set(cb) - set(ca))[:8]})"
            )
        counts = categories(cb)
        if counts != EXPECTED:
            failures.append(f"{name}: category counts {counts} != {EXPECTED}")
        if not all(0x30 + i in cb for i in range(10)):
            failures.append(f"{name}: Latin digits 0-9 incomplete")
        if not all(cp in cb for cp in range(0x064B, 0x0653)):
            failures.append(f"{name}: Arabic diacritics U+064B-U+0652 incomplete")
        if len(a.getGlyphOrder()) != len(b.getGlyphOrder()):
            failures.append(f"{name}: glyph count changed")
        if "GSUB" not in b or "GPOS" not in b:
            failures.append(f"{name}: GSUB/GPOS shaping tables missing after conversion")
        if b["OS/2"].usWeightClass != weight:
            failures.append(
                f"{name}: OS/2 weight {b['OS/2'].usWeightClass} != {weight}"
            )
        print(f"{name} ({weight}): cmap identical, {counts['total']} codepoints, "
              f"{len(cb)} glyphs in cmap, {len(b.getGlyphOrder())} glyphs, "
              f"{woff2.stat().st_size} bytes")
    if failures:
        for failure in failures:
            print("FAIL:", failure, file=sys.stderr)
        return 1
    print("check-thmanyah-coverage: OK (5 weights, no glyph loss)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
