# Local PDF Test Center — Windows Manager

## Purpose and trust boundary

The Test Center is a **separate, printer-free local diagnostic** for Yaseir Print.
It is not a virtual printer, an Agent/Gateway print job, or a physical acceptance test.

The production printer classifier, Windows spooler transport and Gateway virtual-printer
rejection rules remain unchanged. The Test Center does not enumerate or register
Microsoft Print to PDF, OneNote, PDF24, or any other software/redirected queue.

## What is actually executed

1. Open **Yaseir Print Manager → Test Center**.
2. Pick a sample POS receipt, kitchen ticket, bar ticket, or A4-scale invoice. For a real
   Odoo document, export a JPEG/PNG receipt image or PDF and import it locally.
3. For sample receipts, choose **58mm** or **80mm**. Imported JPEG/PNG images default to their original 96-DPI image geometry, or can be explicitly mapped to 58/80mm receipt paper. Imported PDFs retain their embedded page sizes.
4. Click **Run local PDF test**. The Manager writes a protected temporary input file
   under its private ProgramData capture directory, then runs the **bundled Go CLI**.
5. The CLI converts JPEGs using the production `JPEGToPDFReceipt` (or `JPEGToPDF`
   for invoice samples), validates the resulting PDF, and invokes the same embedded,
   headless-safe PDFium WASM engine used by the Windows Agent. PDFium parses and
   renders **all pages** (maximum 10), producing a PNG preview of page one.
6. The CLI writes private PDF and PNG artifacts and returns their local paths,
   SHA-256, byte count and page count. Only a genuine PDFium render result is
   presented as success.

**No** network requests, Odoo credentials, Gateway API calls, printer/Agent registration,
Windows print queue, driver dialog, physical print or print-status reconciliation occur
on this path. A green result means **PDF rendering succeeded**, not paper delivery.

The sample designs are illustrative only. Import an actual Odoo 19 or Odoo 20 export
to inspect its rendering, while separately proving that the Odoo addon runs correctly
on that version. This local test does **not** certify Odoo 20 compatibility.

## Limits, privacy and failure handling

- Input formats: PDF, JPEG and PNG (PNG is rasterized locally to JPEG by the Manager).
- Maximum input: **4 MiB**, bounded raster dimensions, at most **10 PDF pages**.
- The backend enforces format/width allowlists independently from the UI.
- Only 0 (keep PDF geometry), 58 and 80mm (receipt JPEG) are allowed.
- The Manager stages inputs in an ACL-protected machine directory and removes
  temporary inputs on every exit path. Completed PDFs/PNGs are ACL-protected,
  capped at 20 result pairs and deleted after 48 hours during later captures.
- No arbitrary renderer-controlled output directory or fake printer identity.
- A native CLI/rendering error is displayed as a genuine test failure. Source-scoped
  discovery notices remain in the protected Manager log; failed persistence remains
  a localized actionable error rather than a vague technical warning.

## Acceptance checks

- Run Windows Go tests including `TestLocalCapturePDFiumOnWindows` (real PDFium).
- Run Rust unit tests for capture admission, frontend TypeScript and desktop UI smoke.
- Ensure a virtual queue never appears in Printers, Add Printer, Gateway API or bindings.
- Test 58/80mm receipt previews with Arabic/English and import one exported Odoo
  receipt and invoice PDF. Verify generated PDF pages in an external viewer.
- Test one real hardware printer separately before calling physical delivery ready.
- Validate Odoo 19 and Odoo 20 addon behavior separately; do not infer it from this
  local PDF test.

Do not add the Test Center to Odoo print destinations or accept a simulated capture
as a successful real print job.
