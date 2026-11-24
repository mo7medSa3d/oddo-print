# Synthetic receipt fixture

`receipt-geometry.jpg` is a 512 × 2852 JPEG generated from
`tests/fixtures/receipt-geometry.html` through the production
`renderGatewayReceiptJpeg` helper, with Odoo 19's `html-to-image` exporter.
It contains no customer data. It includes twelve long Arabic/English product
descriptions, quantities, amounts, tax, totals, payment, registration marks,
and a QR encoding `YASEIR-GEOMETRY-TEST-20261019`.

The QR matrix was generated with the existing bundled ReportLab tool; no
runtime or project dependency was added. The SVG includes a four-module quiet
zone. Chromium 153.0.8010.52 captured the fixture on 2026-10-19. The HTML uses
a synthetic structured layout; it is not a running Odoo OWL integration test.

JPEG SHA-256: `e70de58555afa0665c1f727619d5b23280d3b3767f0b4cd35cad8873c2252a34`.

To regenerate, mount the HTML in a browser with the addon's receipt CSS and
invoke `renderGatewayReceiptJpeg(element, { width: 512 })`. Use the installed
Odoo 19 `html-to-image` module and `waitImages`, retain the returned JPEG bytes,
and update dimensions/hash if browser font metrics change. Never use real
customer receipt content as a regression fixture. Digital boundary assertions
do not establish physical QR readability or paper output.
