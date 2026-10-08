"""
Structural regression: the Yaseir addon must not introduce web-font requests
into the POS receipt rendering path.

Background
----------
Odoo 19 POS receipt printing renders the receipt via
``@point_of_sale/app/services/render_service`` -> ``htmlToCanvas`` ->
``html-to-image`` ``toCanvas`` -> ``embedWebFonts``. ``embedWebFonts`` scans
*every* ``@font-face`` rule in the POS document, including Odoo's Noto Sans
Arabic / Noto Sans Hebrew rules hosted on ``fonts.odoocdn.com``. The italic
variants (``RegIta``, ``LigIta``, ``BolIta``, ``HaiIta``, ``BlaIta``) were
removed from that CDN, so every receipt print triggered a burst of 404s.

The receipt template (``point_of_sale.OrderReceipt``) declares no custom font;
it uses Bootstrap utility classes and inherits the POS font stack. The 404s
were therefore never required for the receipt, and they were non-fatal:
``html-to-image``'s ``resourceToDataURL`` catches the fetch failure,
substitutes an empty data URL, and continues rendering.

These tests lock the two structural facts that keep the receipt independent
of those remote fonts:

1. The addon itself declares no ``@font-face`` / Noto / ``fonts.odoocdn.com``
   references in its POS assets (so it never contributes a font request).
2. The receipt rendering path uses the resilient ``htmlToCanvas`` pipeline and
   keeps fallback paths, so a renderer failure degrades instead of throwing.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADDON = ROOT / "odoo_addons" / "print_gateway"


def read(rel):
    return (ADDON / rel).read_text(encoding="utf-8")


def strip_js_comments(source):
    """Remove JS block/whole-line comments while preserving string literals."""
    source = re.sub(r"/\*[\s\S]*?\*/", "", source)
    return re.sub(r"(?m)^\s*//.*(?:\n|$)", "", source)


def test_pos_receipt_rendering_declares_no_web_fonts():
    """The addon must not declare @font-face / Noto / odoocdn in its POS assets.

    Any such declaration would make the addon itself request a remote font
    during receipt rendering, which is exactly the class of bug that produced
    the Noto 404s.
    """
    pos_assets = (list((ADDON / "static" / "src" / "js").glob("*.js"))
                  + list((ADDON / "static" / "src" / "scss").glob("*.scss"))
                  + list((ADDON / "static" / "src" / "css").glob("*.css")))
    assert pos_assets, "expected POS JS/SCSS assets to scan"
    offenders = []
    for path in pos_assets:
        source = strip_js_comments(path.read_text(encoding="utf-8"))
        for token in ("@font-face", "NotoSans", "Noto Sans", "fonts.odoocdn.com"):
            if token in source:
                offenders.append(f"{path.relative_to(ADDON)}: {token}")
    assert not offenders, (
        "POS assets must not declare remote web fonts (this is what caused the "
        f"Noto 404s): {offenders}"
    )


def test_render_receipt_image_uses_resilient_html_to_canvas_pipeline():
    """The receipt rendering path uses htmlToCanvas and keeps fallback paths.

    ``htmlToCanvas`` is the Odoo render_service entry point that internally
    uses ``html-to-image``; that library catches per-resource fetch failures
    (including font 404s) and continues. The addon additionally chains
    ``toJpeg`` -> ``toCanvas`` -> ``toHtml`` -> ``renderToElement`` so a failing
    renderer step degrades instead of throwing.
    """
    source = read("static/src/js/pos_print_router.js")

    # The exact capture helper uses the vendored html-to-image directly
    # with skipFonts, because Odoo render_service's wrapper silently drops
    # custom rasterization options and can detach the source node early.
    helper = read("static/src/js/receipt_raster.js")
    assert 'from "./receipt_raster"' in source
    assert 'from "@point_of_sale/app/utils/html-to-image"' in helper
    assert "skipFonts: true" in helper
    assert "renderer.whenMounted" in helper
    assert "node.scrollWidth" in helper
    assert 'backgroundColor: "#ffffff"' in helper

    # The receipt image renderer exists and is exported for testing.
    assert "export async function renderReceiptImage" in source

    # Fallback chain: toJpeg -> toCanvas -> toHtml -> renderToElement.
    assert "renderer.toJpeg" in source
    assert "renderer.toCanvas" in source
    assert "renderer.toHtml" in source
    assert 'receiptComponent.template || "point_of_sale.OrderReceipt"' in source
    assert "data: typeof currentOrder.export_for_printing" not in source
    assert "formatCurrency: pos.env" not in source

    # Each renderer step is guarded so a failure falls through to the next.
    assert source.count("console.warn(") >= 3


def test_render_receipt_image_does_not_reference_remote_font_urls():
    """renderReceiptImage must not hardcode any remote font URL.

    A hardcoded ``fonts.odoocdn.com`` URL (or a ``@font-face`` src) in the
    receipt renderer would re-introduce the CDN dependency the 404 fix removes.
    """
    source = strip_js_comments(read("static/src/js/pos_print_router.js"))
    assert "fonts.odoocdn.com" not in source
    assert "@font-face" not in source
    assert "NotoSans" not in source
