# POS receipt dimensions and printer compatibility — Odoo 19

This feature uses **two separate units**:

- **Raster layout width**: usable printer dots, e.g. 384 (58mm/203dpi), 512 (80mm/180dpi), 576 (80mm/203dpi). This is NOT the same as nominal paper width in millimetres.
- **Physical media**: 58mm or 80mm roll in millimetres, configured in the Windows print driver or explicitly in the Agent. Printer-specific margins are additional to nominal paper width.

Odoo 19's normal receipt renderer uses a 512px/30px CSS snapshot. The Gateway now renders an offscreen, *mounted* copy with styles scoped to the capture. It enforces non-overlapping totals/taxes, amount columns, QR + URLs, and line-item wrapping. The image does not change the interactive POS UI.

## How automatic width selection works

1. The authenticated Odoo-to-Gateway printer inventory exposes a **bounded `printableWidthDots`** field only when the assigned Agent supplied verified/operator-configured `max_paper_width`, or familiar 58/80mm `paper_width_mm` plus optional 180/203 `dpi`. A printer name alone is never a dimension.
2. The Odoo receipt binding resolves the actual company/branch/printer for the receipt (or kitchen printer), obtains the width, and rasterizes an image at that width. Sale Details uses the configured POS receipt binding. Unknown dimensions use Odoo's native 512px layout.
3. **Windows Spooler** image jobs read the printer's current default physical form and DPI via `CreateDCW/GetDeviceCaps` under a bounded probe. If the installed driver reports a 58mm or 80mm roll, the JPEG is converted to a PDF with a matching 58/80mm MediaBox and correct proportional image size, not the old browser 96dpi assumption.
4. Explicitly configured 58/80mm `paper_width_mm` and `capabilities.max_paper_width` take priority over auto-detection; the Windows PDF/DEVMODE pipeline still validates driver acceptance before StartDocW. For A4/Letter or unknown media, the normal PDF/report geometry is retained.
5. **Direct ESC/POS** raster uses its own `RasterMaxWidthFromCapabilities` and the verified width for the physical printer. It does not share the Windows GDI form. Verify the selected printer supports GS v 0 raster commands.
6. **Odoo QWeb PDFs**, invoices, deliveries and purchase documents continue to use the *actual PDF* page size and binding. Do not force thermal 58/80mm geometry onto A4 reports.

## Configuration examples

On the Windows Agent, edit its existing secure config file (`C:\\ProgramData\\YaseirAgent\\config.yaml` unless data directory customized). For a genuine installed 80mm ESC/POS-capable Windows printer queue:

```yaml
printers:
  - id: pos80_front
    name: POS80 Front
    type: spooler
    protocol: spooler
    spooler_name: POS80 Printer
    paper_width_mm: 80
    capabilities:
      max_paper_width: 576
      print_dpi: 203
      supported_protocols: [pdf, image]
```

For a real 80mm/180dpi printer with 512 dots use `max_paper_width: 512`, `print_dpi: 180`; for 58mm/203dpi use `max_paper_width: 384`, `print_dpi: 203`. **Read the device/driver's printable dot-width specifications rather than assigning one of these values to all POS80 printers.** A 58mm/180dpi device can report 360 usable dots, and driver page margins may further reduce it.

This is not a workaround for missing Windows drivers or incorrect paper forms. Windows-installed queues must have their own correct receipt media form and accessible service identity.

## Acceptance checks

- Print the same order as a receipt and as a kitchen/order-change ticket; check item wrapping, subtotal, VAT, bold total and payment row do not overlap.
- Validate an Arabic/English mixed name, a long product name, a QR code with a long invoice URL, and a single-item order.
- On Windows with an actual printer, verify the selected queue's paper form is 58/80mm, no `DM_PAPERWIDTH` silent substitution, output fits the printable area and there is no unwanted shrink/clipping.
- Test at least 58mm/203dpi (384 dots), 80mm/180dpi (512 dots), and 80mm/203dpi (576 dots) when those printers are actually supported. Use Virtual Test Capture to inspect the raw JPEG without hardware, but note that the capture is NOT evidence of physical paper output.
- A missing capability must fall back conservatively; never silently report physically printed from a successful Windows spool submission.
- Preserve arbitrary-sized report PDF documents (e.g. A4) without accidental roll scaling.

## Known limits

- Different Windows drivers may reject a custom full-length receipt form. The Agent reports the driver rejection instead of claiming the document printed or retrying blindly.
- The Gateway cannot reliably infer a particular model's real printable dot width from its name. Operator configuration or the local Windows driver is required; 512px is the **Odoo layout fallback**, not a claim of universal hardware compatibility.
- A 5 MiB Odoo image payload limit and 16,384px canvas height mean exceptionally long receipts must fail visibly rather than truncate silently. Exact final physical print completion requires the actual printer, not an IPP/Winspool acknowledgement.
