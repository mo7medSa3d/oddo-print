# Receipt geometry and physical acceptance

This is an implementation/acceptance guide. The verification package contains
software geometry, rendering and diagnostic PDF evidence; it does **not** prove
that a physical 58 mm or 80 mm printer produced correctly sized paper.

## Preserve the distinction between roll and printable width

Roll width is a media property. Printable width depends on head size, DPI,
driver margins and the selected form. Do not infer that an 80 mm roll exposes
80 mm of printable pixels. Do not fix cropping by globally changing the
Windows printer's defaults or blindly stretching the document.

The network ESC/POS image path requires current validated printable-dot geometry,
its explicit raster command and the matching image geometry fingerprint. It does
not infer 384/512/576 dots from a 58/80 mm roll, model name or default DPI. Physical
media and X/Y DPI remain independent measured fields. Unknown or ambiguous
geometry fails before transmission. JPEG dimensions and projected raster memory
are bounded before full decode.

The Windows document path uses the selected driver's physical form and printable
bounds. PDF/image content is fitted proportionally inside valid printable bounds,
then centered. The agent requests a document form without mutating global queue
defaults; invalid geometry fails before submission. This Windows path is not
restricted by the direct ESC/POS dot-width limit.

## Language and document preparation

Use the QWeb/font-shaping document path for Arabic/Unicode diagnostics, even when
the operator's company and printer names contain only Latin characters. The Odoo
thermal report retains the UTF-8 wrapper, report assets and thermal styles through
Odoo's article preparation step. An English-only Type1 diagnostic writer cannot
substitute for Arabic shaping. A valid PDF or font metadata check does not prove
the installed printer's driver renders those glyphs correctly.

Do not send UTF-8 text or arbitrary escape sequences to a raw printer whose
language/codepage is unknown. Choose a declared supported language or an explicitly
supported raster/document route. Rendering fallback happens before transmission;
it must not cause a second attempt after an uncertain submission.

## Required physical acceptance record

For each supported model/driver/transport, record printer and driver versions,
roll/form size, physical and printable width, DPI, margins, chosen capability,
agent/desktop/addon/Gateway versions and the exact job/receipt IDs. Print:

1. A width ruler, both edge markers and a square to expose clipping or scaling.
2. Short and long receipts on 58 mm and 80 mm media where supported.
3. English/Arabic mixed text, Arabic shaping, numbers, currency, tax and refund
   lines, long item names, QR/barcodes where used, and a representative image.
4. Representative invoice, delivery and label reports through their actual paths.
5. Fault cases: paper out, unplug/replug, slow rendering, cancellation, network
   loss and restart after submission has begun.

Retain scans/photos, measured edges and the device/spooler outcome. Require no
cropped text, readable glyphs, proportional images and correct document content.
Inspect the device before reprinting an unknown result. A successful `EndDoc`,
socket write or IPP job ID establishes transport evidence, not paper completion.

Implementation references: `agent/internal/printer/pdf_geometry.go`,
`pdf_render_bounds.go`, `spooler_receipt_windows.go`, `image.go`, their regression
tests and `odoo_addons/print_gateway/views/gateway_config_views.xml`. See
`RELEASE_GATES.md` for the release decision and `../OPERATIONS.md` for uncertain
outcome recovery.
