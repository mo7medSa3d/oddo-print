# Windows virtual printer acceptance through Gateway, Agent and Odoo 19

Software queues such as Microsoft Print to PDF, XPS, OneNote or a redirected printer **do not prove physical paper output**. Virtual printing is explicit opt-in. A paired Agent may enable **its own locally discovered** software queue, but cannot manage printers belonging to another Agent, and Windows service verification is mandatory.

## Setup and approval

1. Install matching Gateway, Windows Agent service, CLI and desktop binaries. In desktop **Settings**, save/verify the HTTPS Gateway origin and pair the Agent to its intended workspace. **There is no Manager sign-in field in the desktop.**
2. Identify the Windows service account that runs the Agent and verify that the installed spooler queue is visible and can operate in that noninteractive account. Desktop **Printers > Discover** can show virtual queues for *local diagnostics only*.
3. To enable a software spooler for Gateway/Odoo tests, open desktop **Printers > Discover**, then click **Enable Gateway/Odoo tests** beside the local software queue and explicitly confirm. The desktop uses the **paired Agent identity**; no Gateway Manager login is required. The Gateway scopes the registration to that Agent and sets `virtual_spooler_test=true` as desired state. The Gateway web console remains the place for workspace-wide settings and Odoo rules.
4. Wait for the Agent to apply the authorized desired state and confirm it observes the same Windows queue. Pending or unobserved virtual destinations must not be presented as ready for printing.
5. Use **Send test page** from the Gateway console or the paired Agent desktop's **Test Print** action on its *own confirmed printer*. The desktop path uses the paired Agent identity, bounded idempotency key and Gateway ownership check; it cannot access another Agent's printer.
6. In Odoo 19, use the **same workspace's** Gateway integration credentials, select the correct Agent, refresh runtime printers and bind only the approved test destination. Send synthetic receipts, preparation tickets and invoice/reports; verify actual output files and job/status evidence.

## Recommended unattended test: Yaseir file capture

Microsoft Print to PDF (PORTPROMPT), OneNote (Desktop) and XPS are **interactive Windows software writers**; a Windows service in Session 0 cannot guarantee that their Save As / user-profile UI runs. To verify the whole Gateway → Agent print pipeline without real hardware, use the existing **Yaseir file-capture backend**, which saves inspectable bytes without a desktop dialog:

1. On a **test-only Gateway deployment**, set `YASEIR_GATEWAY_VIRTUAL_TEST_MODE=1` and restart the Gateway. Keep this OFF on customer production environments.
2. In the **Windows Agent service environment** (not just the interactive user's shell), set `YASEIR_AGENT_VIRTUAL_TEST_MODE=1`, and configure the `printers:` entry in `agent/configs/config.yaml.example` for `YASEIR_VIRTUAL_TEST_CAPTURE` with `virtual_test_sink: true`. Restart the Agent service.
3. If a nondefault output directory is desired, specify `YASEIR_AGENT_VIRTUAL_TEST_OUTPUT_DIR` as an **absolute local path protected for the service account**; otherwise the output defaults to `%ProgramData%\\YaseirAgent\\VirtualTestPrints`. The backend enforces file ACLs, a 100-file limit and an upper print-size limit.
4. Confirm that the paired Agent heartbeat shows the configured capture printer with `registration_source: config` and active status. It is intentionally **not** advertised as an ordinary Odoo/production destination.
5. Open the Agent desktop and use **Test Capture** on its owned file-capture destination (or use the Gateway's `POST /api/printers/{id}/test-print` with authorized paired Agent credentials and a unique `Idempotency-Key`). The Gateway records a real queued job, the Agent claims and executes it, and the backend writes a `virtual-{jobId}-*.pdf` (or matching payload format) file. Inspect that file, its content and the status transition; do not interpret spooler acceptance as paper output.
6. This mode does **not** allow ordinary Odoo/customer documents to leak to disk. For Odoo → virtual software spooler experiments, use the separately confirmed Windows spooler queue in this guide, or an isolated synthetic/test-only workflow. Never connect a live Odoo tenant to the file-capture sink.

**Version mismatch:** The desktop's Gateway identity probe advertises `features.agentVirtualSpoolerTest` on compatible releases. If the Agent reports “Gateway needs upgrade”, update/restart the Gateway and install a matching Desktop + Windows Agent release. A running service may still be using the older image even though the GitHub branch has the new source.

## Windows and print-path limitations

- **Microsoft Print to PDF** often displays an interactive Save As prompt and may fail when invoked by a Windows service. A spooler job ID or successful submission alone does not establish that a PDF file appeared.
- **OneNote** may depend on a user session and profile; RDP-redirected, fax and other software queues can be unavailable in Session 0. Confirm service-compatible unattended operation before use.
- The Yaseir VirtualCapture test backend is deliberately gated on BOTH Gateway and Agent; paired-Agent diagnostics are allowed, but normal Odoo/customer jobs are not. Never route sensitive real customer data to a disposable or untrusted software queue.
- Print state `queued`, `printing` and even `success` is not direct observation of paper leaving a physical printer.

## Security and acceptance

The Gateway web console still requires its normal role-based login for company-wide administration. **Local virtual test opt-in does not require that login.** The paired Agent is scoped to its tenant, Agent ID and printer. A virtual queue remains non-printable until the service verifies the actual OS printer and reports its observed capability. Confirm unauthorized/cross-Agent denial, stale or disabled printer, rate/quota limits, 401/403 cases, duplicate clicks, lost HTTP responses and replay of the same operation ID, as well as Odoo document mapping and physical or generated-file evidence.

For acceptance, record Windows version, account SID, queue/driver/port, Gateway tenant/Agent/printer identity, desired/applied state, job ID, output and error, timestamp and tester. Mark any unexercised hardware check **NOT_RUN**, not PASS.

## Rollback

Back up Gateway/Agent configuration and database before changing a live environment. Retire or disable virtual test destinations through the Gateway, unbind Odoo test rules and reconcile pending/ambiguous jobs before rollback. Never delete unknown outcomes merely to clear a dashboard.

Windows printing references: https://learn.microsoft.com/en-us/windows/win32/printdocs/startdocprinter and https://learn.microsoft.com/en-us/windows/win32/services/interactive-services.
