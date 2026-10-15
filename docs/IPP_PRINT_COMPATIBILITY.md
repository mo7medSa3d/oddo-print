# Windows printing and IPP document compatibility

## Production paths

The Gateway stores print intent in PostgreSQL; the authenticated Windows
Agent is the only process that sends bytes to the local printer. Treat each
printer as a device with **specific supported document formats**, not a
generic TCP socket.

| Source payload | Agent transport | Actual encoding and outcome |
| --- | --- | --- |
| PDF / Odoo report | Windows spooler queue | Embedded PDFium renders pages to Windows GDI via StartDocW/EndDoc. Windows manages the installed driver and spool queue. |
| PDF / receipt | Direct IPP/IPPS | Ask Get-Printer-Attributes for document-format-supported; use native application/pdf when accepted, convert to genuine multi-page PWG Raster when advertised, or to JPEG for a one-page PDF when JPEG-only. Do not send incorrect MIME bytes. |
| RAW / ESC-POS / ZPL / TSPL | Network RAW port / compatible spooler | Send language-specific commands only when the device and transport explicitly declare that language. Never send ESC/POS as application/pdf or as IPP application/octet-stream by guessing. |

## Why client-error-document-format-not-supported (0x040A) happens

The IPP connection can work perfectly while the printer rejects the
**document format**. IPP Everywhere v1.1 requires image/pwg-raster support and
recommends (does not require) application/pdf. JPEG is mandatory for *color*
devices and recommended for monochrome. Thus a printer at
`ipp://192.168.8.34:631/ipp/print` can legitimately reject direct PDF.

The Agent must query `document-format-supported` on the **specific printer
URI** before submitting Print-Job. It must not infer format support from the
port number, printer's online status, or brand. An explicit unsupported-format
response is a **definite rejection**; do not retry the same bytes blindly.
If the capability probe fails, is denied, returns malformed attributes, or
omits supported formats, the Agent stops **before submitting any document**.
Confirm the exact queue URI and access policy, or select its working installed
Windows spooler driver. A failed probe is not permission to guess PDF support.
Only correctly typed attributes from the IPP printer group establish format
support or current printer state; DNS-SD advertisements remain candidates.

Use an absolute `ipp://`, `ipps://`, `http://` or `https://` queue URL with an
allowed private/link-local IP and port. Legacy plain `IP:port` (including
`[IPv6]:port`) is also supported for IPP; a bare IP or a plain address with a
path is refused by the Gateway because the Agent cannot apply it. IPPS needs
an explicit secure URL. Discovery browses IPv4 and IPv6 independently so a
failed multicast family does not discard another family's results; partial
source failures remain visible.

## IPP rendering and practical limits

- PWG Raster format has a `RaS2` document preamble and big-endian page
  headers, followed by compressed rows. Every page is prepared **before**
  making the single IPP Print-Job request. This avoids multiple physical jobs
  (and therefore duplication when a later page fails).
- The Agent advertises the actual PWG Raster MIME type, not a false PDF/JPEG
  label. Resolution and color mode are selected from the printer's
  `pwg-raster-document-resolution-supported` and
  `pwg-raster-document-type-supported` when available. Malformed or
  unsupported capabilities fail before submission. Explicit IPP unknown/no-value
  raster settings also fail; the existing 300DPI/grayscale compatibility defaults
  apply only when those lists are omitted, and still require device acceptance.
- For devices that accept JPEG but not PWG, a **single-page** PDF may be
  rendered as JPEG before IPP submission. Multiple pages are not silently
  dropped.
- To protect Windows service memory, bitmap pages and the final payload are
  bounded. Extremely high DPI, oversized raster jobs, uncommon PWG color
  variants, Apple URF/PCLm-only firmware, long-edge feed / media rotation,
  custom ICC/color management and unusual layouts require their supported
  device driver / Windows spooler path rather than mislabeling bytes.
- Acceptance requires HTTP200 with `application/ipp`, a correlated valid IPP
  response and typed server-assigned Job evidence. Another HTTP status, wrong
  content type or malformed response after transmission retains **UNKNOWN**;
  it must not trigger an automatic physical retry.
- Accepted submission does not prove paper output. The current Agent validates
  and logs the returned Job identity but does not persist it for later
  Get-Job-Attributes reconciliation. That operation can track the same Job;
  physical output still needs device evidence or a human/operator test.

## Windows setup for printers that do not accept native PDF

1. Verify the device is reachable and installed in Windows **Settings →
   Bluetooth & devices → Printers & scanners**. Prefer the Microsoft IPP Class
   Driver (for Mopria/IPP Everywhere printers) or the verified vendor driver
   for legacy devices.
2. For an IPP-capable model with poor direct PDF support, select the installed
   Windows queue as a Yaseir `spooler` printer. It uses GDI + the installed
   driver/Windows modern stack to negotiate data the device understands.
3. Confirm you chose the **print queue**, not `Canon ... FAX`, Microsoft
   Print to PDF, OneNote, a redirected RDP queue, or another virtual writer.
4. Run a local Windows Test Page and a Yaseir Test Print separately, then
   compare Spooler Job ID, Agent timeline, and physical paper output.

For a protocol-level inspection from a machine with CUPS `ipptool` installed,
run an appropriate Get-Printer-Attributes request against the exact
`ipp://.../ipp/print` URI and record `document-format-supported`, PWG
resolution/color capabilities, `printer-state-reasons`, and
`media-col-database`. **Never embed printer passwords into logs.**

## Verification checklist

- IPP fake-device tests: native PDF, raster-only, JPEG-only, rejecting-jobs,
  spoofed attribute groups/types, failed/missing capability proof with zero
  document submissions, 0x040A, HTTP/media envelope and unknown-outcome no-blind-retry
- Raster unit tests: PWG header/color model, repeated rows, PackBits
  round-trip, multi-page boundaries, printer-advertised DPI
- Windows CI: real embedded PDFium render + output MIME and NSIS installer
- Physical acceptance (not available in CI): multiple vendor devices/driver
  stacks, thermal 58/80mm, LAN/IPPS vs USB, unplug/replug, printer jams,
  paper-out, interrupted network, actual paper compared with generated PDF

## References

- [RFC8010 IPP encoding and HTTP transport](https://www.rfc-editor.org/rfc/rfc8010.html#section-3.4.3)
- [RFC8011 Get-Printer-Attributes](https://www.rfc-editor.org/rfc/rfc8011.html#section-4.2.5.2)
- [PWG IPP Everywhere v1.1](https://ftp.pwg.org/pub/pwg/candidates/cs-ippeve11-20200515-5100.14.pdf) — document-format conformance
- [PWG Raster Format 5102.4](https://ftp.pwg.org/pub/pwg/candidates/cs-ippraster10-20120420-5102.4.pdf) — header, compression and media rules
- [How to Use IPP](https://www.pwg.org/ipp/ippguide.html) — Get-Printer-Attributes, Print-Job, media and status
- [Microsoft modern print platform](https://support.microsoft.com/en-us/windows/modern-print-platform-4f59fa38-3419-41c7-a6a7-8ca4e21f70bc)
- [Microsoft IPP Class Driver](https://learn.microsoft.com/en-us/universal-print/fundamentals/universal-print-connector-with-ipp)
