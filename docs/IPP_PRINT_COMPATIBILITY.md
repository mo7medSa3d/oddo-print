# IPP compatibility and safe recovery

The registered endpoint and its advertised document formats determine whether
an IPP route is usable. An open port, a thermal-looking name or an IPP URL alone
does not establish that a printer accepts PDF. The implementation and software
checks are in `agent/internal/printer/ipp*.go` and the corresponding tests.

## Admission and format selection

Use the exact advertised queue URI. Agent configuration requires an allowed
private/link-local address and permitted port, with no embedded credentials.
Normalization preserves TLS, port, path and path case; equivalent aliases reuse
the retained registry identity. Different queue paths/security modes remain
different destinations. Re-adding an equivalent endpoint preserves disabled
intent rather than creating a newly enabled duplicate.

Before document submission, `Get-Printer-Attributes` must return bounded valid
capability evidence. Native `application/pdf` permits PDF pass-through. Supported
Windows rendering can prepare PWG Raster, or a bounded single-page JPEG where
the printer advertises it. A non-Windows agent without that renderer rejects a
raster-only requirement before submission. It does not relabel PDF bytes as an
image. Missing/malformed/denied format evidence fails closed.

The HTTP(S) transport URL and the IPP operation's `ipp://`/`ipps://` printer URI
have different protocol roles. TLS verification and original endpoint identity
must remain enabled. Redirects are not a way to discover a fallback destination.

## Acceptance is evidence, not paper output

An acceptable response needs HTTP 200, IPP media type, the correlated request ID
and valid typed job evidence. A correlated client refusal can establish known
non-submission. Server errors, malformed responses, redirects, disconnects or
non-IPP responses after `Print-Job` may leave physical outcome unknown.
Do not automatically repeat the request or switch to RAW/spooler after that
boundary. Preparation fallback is permitted only before any print side effect.

Printer-state evidence is also distinct from transport reachability. Explicit
idle/processing, offline/shutdown and media/cover/toner/jam conditions are useful;
an unreadable, unauthorized or failed probe is unknown rather than proof of an
offline or ready device.

## Acceptance procedure

1. Record model/firmware, endpoint/queue, TLS trust, advertised formats/media/DPI
   and the exact agent/Gateway release.
2. Exercise a small PDF and representative multi-page or receipt document only
   through the format actually advertised and implemented on that OS.
3. Record request ID, returned IPP job ID/state, Gateway claim/receipt and agent
   local ledger. Confirm actual pages separately.
4. Test a correlated refusal before print, a dropped response after submission,
   malformed capability data, credential rejection and reconnect. Confirm there
   is no automatic duplicate after an unknown outcome.
5. Verify that a second same-name device remains independent and an equivalent
   alias retains the existing identity/operator-disabled setting.

Local synthetic IPP tests prove bounded protocol behavior. They do not certify
all printers, printer languages, driver media widths or physical output. Read
`RECEIPT_GEOMETRY_RELIABILITY.md`, `RELEASE_GATES.md` and `../TROUBLESHOOTING.md`
before declaring a device class supported for launch.

Protocol references: RFC 8010 (<https://www.rfc-editor.org/rfc/rfc8010.html>) and
the IPP URI scheme RFC 3510 (<https://www.rfc-editor.org/rfc/rfc3510.html>).
