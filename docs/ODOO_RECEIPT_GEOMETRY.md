# Odoo receipt geometry in V3

Current addon version: `19.0.2.36.0` (V5 preserves the V3 receipt-geometry contract).

POS receipts, kitchen tickets and the in-session Sale Details receipt use the
geometry reported for their selected execution destination. Unknown geometry produces
a compatibility error before a new image is queued. The previous 512-dot default,
288–576-dot clamp and nominal-roll width guesses are not compatibility modes.

This document concerns browser-rendered JPEG receipts. Ordinary Odoo QWeb PDF
reports retain their document route, report access checks and binding semantics.

## Authoritative measurements

The common contract is `capabilities.geometry`, version 1. The complete type and
shared acceptance vectors are in `src/lib/printer-geometry.ts` and
`contracts/printer-geometry-fixtures.json`. The Odoo validators are
`odoo_addons/print_gateway/printer_geometry.py` and
`odoo_addons/print_gateway/static/src/js/printer_geometry.js`.

Each snapshot identifies the Agent execution printer with `printer_id`, declares
its `source` and `validation`, carries an `observed_at` UTC timestamp, and includes
an opaque `config_fingerprint`. Its required measurement is
`printable_width_dots`. Driver and IPP observations use `observed`; an explicitly
configured and validated measurement profile uses `configured`.

The snapshot can also contain independent horizontal and vertical DPI, actual
paper dimensions, printable height, imageable offsets, and the explicit
`raster_command: "gs_v_0"` capability. Missing measurements remain absent. Odoo
does not turn missing values into a nominal 58 mm or 80 mm roll, 203 DPI, a zero
offset, or a guessed command language. All optional numbers are checked without
string coercion. When media, DPI and printable dimensions are known, the printable
extent plus any known offset must fit the paper, allowing one device dot for
rounding.

The Gateway publishes a usable snapshot only after its printer identity and
configuration revision checks succeed. Odoo discovery keeps a geometry snapshot
only if it validates and names the returned printer. The POS metadata methods
resolve the same company, branch, POS and preparation-printer binding as the print
action, and read that target's current runtime measurements. They do not use a
global receipt width. Compatibility RPCs that return only the raster width still
require the complete receipt profile and fail when it is unavailable.

An operator can supply measured values through the existing Gateway printer
configuration's `geometry_profile`. The Agent validates and reports that profile;
the submitted configuration itself is not treated as an observed capability.
No Odoo diagnostic console or customer print-test interface is introduced.

## Supported receipt transports

| Selected execution path | Receipt requirements | Result |
| --- | --- | --- |
| Windows spooler, including a USB printer selected through its driver | Valid identity-bound geometry, both DPI values and actual paper width | JPEG receipt supported through the driver image/PDF path |
| Approved PDF file output | Fresh `pdf_output` verification plus full explicit page geometry: paper width/height, printable width/height, X/Y DPI and X/Y offsets | Read-back-verified PDF artifact; no physical-print claim |
| Direct USB ESC/POS | Valid identity-bound geometry, both DPI values and explicit `gs_v_0` capability | JPEG receipt supported; unknown paper width may remain absent |
| Direct TCP/network ESC/POS | The same explicit raster capability and typography measurements as USB | JPEG receipt supported |
| IPP/IPPS | Native document negotiation belongs to the PDF-report path | Raw POS JPEG input is not supported in this release |
| Unknown firmware, protocol, geometry or DPI | No measurement or command substitution | Receipt rejected before enqueue |

For direct raster printing, an explicitly present `supported_protocols` list must
also permit image/JPEG/ESC-POS. An empty, malformed or conflicting list rejects the
receipt. An `escpos` label alone cannot establish that a device implements GS v 0.
Printer model/class labels do not authorize byte commands.

IPP PDF negotiation can select a printer-advertised document representation after
inspecting the original PDF and its media. That is separate from accepting an
Odoo browser JPEG as the original print input. A driver/document binding used by
ordinary reports is not forced to have receipt typography measurements merely to
remain a valid report binding.

## Physical layout and raster density

CSS layout and raster pixels are separate quantities:

```text
printable width in mm = printable_width_dots × 25.4 / dpi_x
CSS layout width      = printable_width_dots × 96 / dpi_x
output width          = printable_width_dots
output height         = ceil(CSS content height × dpi_y / 96)
```

The renderer supplies explicit canvas dimensions and a pixel ratio of one, so
browser device pixel ratio does not silently change the output size. Independent
X/Y DPI values are respected. Direct raster typography can therefore use measured
dots and DPI without inventing a paper size. Driver image conversion additionally
needs the actual media width. Approved PDF file output requires both actual page
dimensions, both printable dimensions and explicit X/Y offsets so it can place
and paginate the image without inventing a page or margin.

Receipt typography is 10.5 pt, equivalent to 14 CSS px and approximately 3.704 mm
per em. Increasing printer DPI increases the pixels used to draw the text; it does
not reduce its physical font size. Millimetre-based padding and gaps, explicit
amount/quantity columns and the existing RTL layout protections apply at the
selected physical width. Narrow-layout selection uses derived physical width,
not a fixed raster-dot threshold.

The renderer waits for fonts and receipt images before encoding. A missing or
timed-out QR code/logo fails the operation instead of producing a receipt that
silently omits that image. It uses a local system-font stack and does not require
an external web font during capture. The measured layout must fit the selected
width. Unexpected canvas resizing, clipped overflow, invalid JPEG export and a
failed mounted render are reported through the existing controlled error path.

## Bounds and long receipts

The existing security limits remain: at most 16,384 pixels per JPEG dimension,
40,000,000 decoded pixels and 5 MiB of encoded JPEG data. The actual output is
checked as well as the planned dimensions. Automatic canvas downscaling is
disabled. Exceeding a bound gives a clear pre-enqueue error; the receipt is not
silently narrowed to fit a canvas, page or byte budget.

| Vertical DPI | Maximum height from the 16,384-dot dimension limit |
| --- | ---: |
| 203 | 2,050.018 mm |
| 300 | 1,387.179 mm |
| 600 | 693.589 mm |

These are upper bounds for a single accepted raster, not promises about paper
length or device memory. The pixel-count limit, encoded-size limit or actual media
can impose a lower bound. For example, at 1702 dots wide the pixel-count ceiling
still permits 16,384 rows, but a sufficiently complex JPEG can reach 5 MiB sooner.
Within the accepted bounds, downstream raster bands and driver pages preserve
the image's intended width. The Odoo client does not create multiple independently
identified jobs to evade a size limit.

## Geometry changes and uncertain outcomes

Every new image payload carries `geometry_fingerprint`, copied unchanged from the
snapshot used to format the image. Odoo checks it against the selected current
profile before new admission, and the Gateway and Agent retain their own identity,
revision and geometry checks. A driver, destination, media or DPI change can
invalidate a previously formatted image even when its width would still fit.
Observation timestamps and transient online/offline status are not new physical
measurements and do not by themselves justify reformatting an existing operation.

The browser keeps the original JPEG, fingerprint and operation key while a receipt
has an unresolved outcome. It does not render new bytes under the same key, mint
a new retry key, route to native printing, or assume that a timeout means no paper
was produced. Kitchen ownership and edit-in-flight protections remain in place.
The durable outbox retains the accepted payload verbatim. Historical already
accepted payloads are not rewritten to fabricate a new geometry fingerprint.

An exact previously persisted operation can return its existing job and outcome
even when live geometry has changed. Current record, company and binding
authorization still runs. The replay lookup uses ordinary outbox read ACLs and a
fresh source-record access/company check; it matches the stored Gateway config,
printer, destination identity, document type, source identity and complete payload.
The stored payload stays an administrator-only field. After the caller-UID
lookup and source/company authorization succeed, only its internal equality read
uses elevated access; no payload bytes are returned and the public field ACL is
unchanged. This permits an ordinary authorized POS operator to reconcile the
original job without gaining document access. It is read-only: no new row, status
reset, payload replacement or outbound print submission occurs. Changed payloads, fingerprints or route/source identities
conflict. A new operation with an old fingerprint still fails before enqueue.
The existing outbox/status worker owns reconciliation. Resolve an unknown physical
outcome before deliberately creating new paper output.

## Upgrade and deployment

1. Preserve the existing outbox, job identities, installation identity and
   unresolved-operation records. Use the normal backup and upgrade procedure.
2. Deploy the matching Agent and Gateway geometry contract and obtain a converged
   observation or a validated measurement profile for each receipt printer.
3. Upgrade `print_gateway` to `19.0.2.36.0` using the ordinary Odoo module update.
   The `19.0.2.22.0` schema increment added nullable output-medium, output-outcome
   and canonical artifact-evidence columns through Odoo's normal schema update;
   V5 preserves those columns and existing jobs, credentials, identities and
   payloads while applying the current authorization and recovery fixes.
4. Reload the POS/backend asset bundles. An older open POS client has no geometry
   fingerprint and cannot create a new receipt through the V3 admission path.
5. Check the selected binding and actual measurements before restoring new
   receipt creation. Printers with unknown legacy geometry need an explicit
   profile or real driver observation; they do not receive guessed compatibility
   values.

Plan the deployment so old clients do not keep submitting while the contract is
being upgraded. Do not clear uncertain jobs or counters as a deployment shortcut.
Existing company/branch access checks, installation proofs, idempotency keys,
request limits, pinned HTTP/TLS transport checks and retry lifetimes are retained.

## Verification and its limits

The historical V3 lane evidence is in `evidence-v3/printer/odoo/` in its verification package.
Its execution manifest binds commands and raw results to source hashes. It retains
the failing baseline demonstrations as well as successful reruns. The native
Odoo gate uses the recorded Odoo 19 source revision
`14f9b8149d5260d92fb74404df09483fb42dd820`, a non-root OS process and isolated
PostgreSQL databases. The log inventory checks every source-defined native addon
test method rather than treating Odoo's fixture-inclusive statistics as a test
count.

`scripts/acceptance/odoo-receipt-browser.mjs` runs the production receipt module and
CSS with the exact Odoo `html-to-image` implementation and image-wait helper in
Chromium. It covers measured 58 mm/203 DPI, 80 mm/203/300/600 DPI, a custom 104 mm
profile, independent 203×300 DPI and a long 600 DPI receipt. Synthetic content
contains mixed Arabic/English text, amount columns, a QR code and Code 128. The
gate records actual CSS/raster dimensions, font size, RTL direction, column overlap,
JPEG hashes and external network requests. A test-only pinned `zxing-cpp` decoder
checks the codes in the resulting images. Its downloaded wheel provenance and
hash are retained separately; it is not a product dependency.

The final digital browser run produced a 1702×12969 long receipt at 600 DPI with
the same physical font size as the 203 DPI cases. The Agent lane also feeds these
JPEGs through its production monochrome GS v 0 conversion, reconstructs each
band, checks white trailing packed bits for non-byte-aligned widths, and decodes
the same QR and barcode values. These checks exercise rendering and byte encoding,
including 851- and 1702-dot widths. They do not establish printer firmware support,
physical scan quality, cutter/feed behavior, a Windows driver result or live
authenticated POS behavior.

All 108 hardware matrix cases retain their explicit BLOCKED/UNVERIFIED disposition
until the specified physical printers, media, operating systems and failure cases
are exercised. Synthetic profiles are test inputs, not evidence of a customer's
printer measurements. No software test result is promoted to a physical-print pass.

## Current operational eligibility

Geometry describes formatting; it does not prove that an execution endpoint
exists. The Gateway and Odoo require the separate versioned
`capabilities.operational_verification` proof. Odoo validates its exact printer
identity, transport-specific verification method, output medium, identity digest,
source timestamp and Gateway receipt timestamp. Proofs and receipts expire after
300 seconds; source clock skew is bounded to 60 seconds in the future. The cached
picker checks freshness again when selected, and binding resolution repeats the
check before admitting new work. Arbitrary software queues, a manually entered IP
and a merely open port do not establish this proof.

The approved file destination is labelled PDF file output. Its public opaque
profile selector maps to an Agent-local approved directory; no filesystem path
is accepted from Odoo. Ordinary PDF reports and POS receipt images both use that
explicit backend. An unavailable or unknown output profile stays unavailable;
it is not converted into a Windows dialog-driven virtual queue.

## Standard-page receipts and digital file proof

A4, A5, Letter and Legal are ordinary configured media profiles. The receipt
renderer uses their authoritative printable width and DPI with the same 14 CSS px
physical typography as thermal profiles. The capture root resets outside margins;
otherwise Odoo's kitchen template top margin can shift the cloned image and cut
off its last rows. Inner receipt spacing and explicit printable offsets remain
separate.

The file backend carries the original JPEG once and places contiguous source-row
segments at their original X/Y physical scale in the declared page boxes. It
chooses a fully blank horizontal gap before each printable-height limit so an
ordinary QR or barcode block is not split across pages. A continuous opaque image
without a safe break is rejected before publishing a file with an actionable
request for a pre-paginated PDF or suitable media. The existing image bounds
remain unchanged; this does not permit an unbounded document or hidden downscale.

`scripts/acceptance/odoo-standard-page-browser.mjs` mounts actual Odoo 19 Owl
OrderReceipt, ReceiptHeader, OrderDisplay, Orderline, SaleDetailsReport and
OrderChangeReceipt templates with synthetic records/services and the exact local
Odoo Bootstrap, receipt CSS, image-wait and HTML-to-image implementation. The 16
cases cover sale, refund, Sale Details and kitchen output on A4 at 203 DPI, A5 at
300 DPI, Letter at 600 DPI and Legal at independent 203×300 DPI. English and Arabic,
negative refund amounts, column alignment, exact QR/Code128 payloads, bounds,
physical font size and network independence are checked. A code block deliberately
crosses the old fixed-height page boundary.

The browser gate passed all 16 cases and decoded 40 codes, including 32 required
fixture QR/Code128 values and eight additional Odoo receipt QR images. The native
lane then created and read back 16 actual approved-output PDF files containing
35 pages. Poppler page renders decoded the required QR/Code128 values in every
case; exact source-row coverage, preserved physical scale, unchanged embedded
JPEG and intact encoded QR modules were independently checked. Blank quiet-zone
padding may span a page break; the encoded modules must remain intact.

These are digital software tests with declared synthetic measurements and a
transient authorized output directory. They do not prove a customer's printer
exists, that a Windows driver produced paper, that a physical barcode scanner can
read the paper, or that a live authenticated POS transaction ran end to end.
All 108 hardware cases remain BLOCKED/UNVERIFIED. The earlier 2.19.0 thermal and
248-method Odoo evidence stays unchanged; new 2.20.0 evidence is recorded separately.
