# Virtual printer end-to-end testing (no physical printer)

**Scope:** Agent file-capture testing, not hardware certification. Virtual capture proves that an authorized Gateway test job was validated, queued, delivered to the Windows Agent, accepted by its backend, and written to disk. It cannot prove paper feed, ESC/POS timing, driver/device response, or the physical printer's final state.

## 1. Enable the opt-in lab mode

In the **Agent service environment**, set:

```text
YASEIR_AGENT_VIRTUAL_TEST_MODE=1
YASEIR_AGENT_VIRTUAL_TEST_OUTPUT_DIR=C:\\ProgramData\\YaseirAgent\\VirtualTestPrints
```

In the **Gateway server environment**, set:

```text
YASEIR_GATEWAY_VIRTUAL_TEST_MODE=1
```

Set the variables in the actual service/server launch environment (not just a temporary PowerShell session). Restart the Agent Windows Service and Gateway so both processes receive them. These flags default to OFF. Enable only on a test environment and disable after testing. The Gateway accepts virtual output only for an RBAC-authorized **Manager Test Print**, never Odoo production printing, automatic routing, force reprint, or an arbitrary API job.

## 2. Add the special virtual capture printer to the Agent's `config.yaml`

By default on Windows, edit `C:\\ProgramData\\YaseirAgent\\config.yaml` with administrative rights (or your `YASEIR_AGENT_DATA_DIR` override). Append the following to the existing `printers:` list (or create it if absent). Do not overwrite existing `server`, `agent`, pairing secrets, or other printer entries:

```yaml
printers:
  - id: yaseir_virtual_test
    name: Yaseir Virtual Test Printer
    type: spooler
    protocol: spooler
    spooler_name: YASEIR_VIRTUAL_TEST_CAPTURE
    printer_type: virtual
    capabilities:
      virtual_test_sink: true
      supported_protocols: [pdf, image, raw, escpos, zpl, tspl]
```

The reserved `spooler_name` is **not** an installed Windows queue. With this exact configuration and the Agent flag enabled, the backend captures bytes into a file under the chosen output directory. Without the flag or capability marker, the reserved queue fails closed; a normal physical Windows Spooler connection is never attempted.

## 3. Verify the end-to-end path

1. In the Gateway Printers page, find **Yaseir Virtual Test Printer** after the Agent refresh/heartbeat, and confirm the Agent is Online.
2. Use its **Test Print** action as a Manager authorized for `printers.test`.
3. Open the job detail. It must traverse queued → claimed → printing → success (or show a specific failure); **success means the test file was captured, NOT that paper printed**.
4. On the Agent Windows computer, open `C:\ProgramData\YaseirAgent\VirtualTestPrints` (or your explicit output directory). A new `virtual-job_...-....pdf` should exist; open it and inspect the rendered content. Byte-language tests may produce `.raw`, `.escpos`, `.zpl` or `.tspl` files which are binary command streams, not printable PDFs.
5. Test queue disconnection/reconnection, two sequential jobs, bad PDF payload rejection, job cancellation, and the display of status/errors. File captures are private (service ACL) and capped at **100 files**, with a **5 MiB per-job** limit. Archive/remove captures explicitly to make room.

**Microsoft Print to PDF / XPS / OneNote / vendor FAX queues** are intentionally NOT promoted by this feature. Those Windows drivers can require an interactive Save As dialog, launch another app, or transmit faxes and often cannot run safely from a Session 0 Windows Service. This built-in file capture requires neither a printer driver nor a desktop prompt. If you specifically need to test a third-party virtual driver, configure its unattended auto-save support with the vendor's instructions and validate separately under the Windows Service account.

## Diagnosing a test-print job from the Desktop or Gateway

When a diagnostic is still queued, claimed, or printing, pressing **Test Print**
again checks the SAME idempotent operation; it does **not** create another
paper print or output file. After a terminal result, a new operation requires
an explicit in-app confirmation. Cancel if you have not checked the destination.

For reliable headless end-to-end delivery tests, prefer the built-in Yaseir
virtual capture backend. On a successful capture, the job confirms durable file
output, not printer hardware. Microsoft Print to PDF and OneNote are application
writers that can ask for Save As / notebook selection; these dialogs cannot
be shown from a Windows Service running in Session 0. A spooler handoff to such
a queue alone does not prove a PDF was saved or a OneNote page was created.
Do not automatically retry an uncertain job; inspect the output and job
timeline first. Hardware/POS printer certification still requires a real printer.

## 4. Shut off

Disable both flags, restart services, and the synthetic virtual printer is excluded from managed discovery again. Existing capture files remain on disk for inspection and are not silently deleted. All existing production physical-printer and redirected-printer restrictions remain unchanged.

## Known limitations

- Only the explicit configured Yaseir capture sink is test-routable. Other virtual/fax/redirected queues remain blocked by default.
- A saved file is not evidence of a real Windows spooler job or physical paper. Verify native spooler/USB/IPP and printer hardware separately after equipment is available.
- This opt-in feature does not allow arbitrary payloads to be written to a caller-selected path; filenames are generated in the local administrator-configured output directory.
