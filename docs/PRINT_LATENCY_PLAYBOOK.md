# Print latency and Windows output investigation playbook

## Scope, evidence and status

This document records source-level latency risks in Yaseir Print, not measured production root causes. There were no captured customer production logs, Windows hardware timings, or verified POS80 paper-output tests during this change. A Gateway "success" is a transport acknowledgement; it must never be described as independently verified paper output.

Job path: Odoo report/POS -> Odoo post-commit durable outbox -> Gateway API -> PostgreSQL queue/NOTIFY -> WebSocket preferred, HTTP polling fallback -> Agent local SQLite execution fence -> Windows spooler/IPP/RAW/ESC-POS -> Gateway terminal receipt -> Odoo status reconciliation.

## Measure before changing transport or timeout settings

Use the existing structured print.trace logs. Run locally, on private redacted log copies (not on third-party web services):

    node scripts/print-latency-report.mjs gateway.log agent.log odoo.log
    node scripts/print-latency-report.mjs --json gateway.log agent.log odoo.log

The report emits only counts, observed p50/p95/max stage timings, and a caution. Raw logs may still contain sensitive operational metadata: restrict read access to input logs and remove them according to your retention policy. Do not add stage percentile values together; these measurements originate in different processes, overlap, and are not a synchronized end-to-end timer. Large samples still consume memory as numeric data, but individual raw lines are not retained. A small sample count cannot establish representative p95.

Representative stages: odoo_pos.width_lookup, odoo_pos.receipt_render, odoo.persist, odoo.gateway_submit, gateway.enqueue, gateway.claim, gateway.websocket_send, gateway.delivery_evidence, agent.sqlite_ledger, agent.gateway_status_report, agent.transport_total, windows.raw_spooler_preflight, windows.raw_spooler_session, windows.pdf_worker_wait, windows.pdf_spooler_preflight, windows.pdf_renderer_acquire, windows.pdf_first_page_render, windows.pdf_start_document, windows.pdf_end_document, windows.pdf_total, agent.raw_network_write, agent.ipp_submission.

Odoo POS browser timings are logged in the browser console. Preserve only the print.trace timing lines from that console, redact all other console text and use the sanitized lines as another input file to the analyzer. The browser raster steps occur before the Odoo/Gateway print job is submitted.

Investigate large values:
- odoo_pos.width_lookup: the POS asks Odoo for a hardware-specific current receipt width on every action. This prevents incorrect 58/80mm paper scaling, so cache only with printer/binding revision evidence.
- odoo_pos.receipt_render: browser mounting and JPEG capture, potentially affected by complex HTML, font loading, receipt length, DPI and device CPU.
- odoo.persist or odoo.gateway_submit: Odoo transaction, report generation, network TLS and Gateway admission; check response time on the same Odoo worker, then database locks.
- gateway.enqueue/claim/delivery_evidence: PostgreSQL and concurrency, subscription/printer gates, connection pool, explain query plans and lock waits. Keep tenant isolation, idempotency and SKIP LOCKED.
- gateway.websocket_send: socket buffer backpressure and large base64 payload. This PR removes one redundant serialization without weakening the byte-size gate.
- agent.sqlite_ledger and agent.gateway_status_report: disk fsync/locking versus Gateway round trip; fenced status reports are required before a potentially irreversible print.
- windows.pdf_worker_wait: the Windows PDF renderer currently uses a single global slot. Benchmark actual concurrent workloads/memory before adjusting it.
- windows.pdf_renderer_acquire/first_page_render: embedded WASM cold start, rendering complexity, bitmap dimensions, per-page memory; never blindly bypass device capability checks.
- agent.ipp_submission: IPP target network, accepted PDF format, round trips and job-response parsing. Obtain IPP job-state evidence; avoid treating connection success as paper completion.
- agent.raw_network_write: RAW TCP write duration. This is kernel acceptance, not final printer hardware completion.
- windows.pdf_start_document / pdf_end_document / raw_spooler_session: printer driver or print server may block even with a healthy Agent. Inspect Windows PrintService Operational log and the actual queue.
- High Odoo UI/status lag with low transport time: the Odoo cron is a reconciliation surface, not the delivery trigger. In this PR its scheduled interval changes from two minutes to one; Odoo cron workers can still fall behind under load.

## Comparable vendor and standards practice

- Microsoft documents StartDocPrinter as a synchronous blocking call whose latency depends on network, spooler configuration, and driver. Do not block the Desktop/UI on this call or treat returning as paper proof: https://learn.microsoft.com/windows/win32/printdocs/startdocprinter
- Microsoft Windows services in Session 0 should not depend on interactive Save As dialogs. Microsoft Print to PDF and OneNote may need a user session; use Yaseir's explicit file-capture backend for unattended integration tests: https://learn.microsoft.com/windows/win32/services/interactive-services
- IPP Everywhere supports driverless discovery and standard formats. Prefer a negotiated native supported format over repeated raster/PDF conversions, but NEVER send arbitrary PDF as RAW/ESC-POS or invent printer capabilities: https://www.pwg.org/ipp/everywhere.html
- PaperCut Mobility Print uses native print queues and describes PDL passthrough as an optimization only when compatible drivers/formats are known. It also prefers local network job delivery when the client and server can connect. Yaseir should borrow the validated fast-path principle, not bypass tenant-scoped cloud authorization or ACK fencing: https://www.papercut.com/kb/Main/passthrough-mode-in-mobility-print/ and https://www.papercut.com/help/manuals/mobility-print/setting-up-cloud-print-for-mobility-print/cloud-print-overview/
- Odoo cron interval is not a real-time delivery protocol. Keep post-commit submission and bounded recovery/status batches with progress accounting: https://www.odoo.com/documentation/19.0/developer/reference/backend/actions.html . On Odoo.sh, scheduled actions are best effort and should not be expected to run more often than every five minutes, even if an XML interval is one minute: https://www.odoo.com/documentation/19.0/administration/odoo_sh/advanced.html
- QZ Tray illustrates a secure, signed local-client WebSocket bridge for printing. Its architecture also acknowledges that local spooler acceptance cannot prove final paper output: https://github.com/qzind/tray/wiki/Architecture
- ezeep documents persistent outbound connectors and cloud-hosted print-format rendering, while Yaseir currently performs device-specific processing on the Agent. Do not migrate renderer placement before measuring network cost, data-security boundaries and scale: https://www.ezeep.com/learn/how-cloud-printing-works

## Operational acceptance matrix (not yet executed here)

1. Cold and warmed Agent: send ten uniquely keyed 58/80mm POS receipts, ten A4 PDFs, and at least one multi-page PDF. Record p50/p95 per print.trace stage; inspect contents and correct paper width.
2. Compare WebSocket healthy versus interrupted/blocked: queued/claimed/printing/success transitions, ≤5s polling cadence when disconnected plus networking/DB time, no duplicate paper after reconnect.
3. Run independent physical printer queues simultaneously and compare Windows PDF worker queueing. Measure, then consider bounded parallelism only if hardware memory/driver tests prove it safe.
4. Disconnect Agent at before-claim, after-claim/before-delivery, after-Windows-StartDoc, and after-spooler-completion points. Ensure ambiguity remains UNKNOWN and never silently reprints.
5. OneNote and Microsoft Print to PDF are virtual software destinations; confirm file/notebook output under the proper interactive Windows account, not merely queue handoff. Use built-in virtual file capture for headless tests.
6. Capture CPU, memory, database locks, agent local SQLite latency and print-server event logs during load. Set SLOs from the baseline (e.g. p95 Gateway acceptance-to-Agent-admission under one second on stable WS as a proposed goal, NOT a verified result). Do not weaken authentication, payload caps, cancellation, claim fencing, transport compatibility or terminal reconciliation to hit a time target.

On the Windows Agent computer, inspect the built-in spooler and its operational log (administrator permission may be required). Do not paste raw logs containing customer names or document titles into support tickets:

    Get-Service Spooler
    Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus
    Get-PrintJob -PrinterName "POS80 Printer"
    Get-WinEvent -LogName "Microsoft-Windows-PrintService/Operational" -MaxEvents 40

Enable the PrintService/Operational channel in Event Viewer if disabled. Microsoft describes the JOB_STATUS_COMPLETE signal as a successful handoff to the printer, not proof of printed paper: https://learn.microsoft.com/en-us/windows/win32/printdocs/job-info-1

Windows hardware, printer driver and Odoo 19 runtime acceptance must be performed on the corresponding real environment before production readiness can be declared.
