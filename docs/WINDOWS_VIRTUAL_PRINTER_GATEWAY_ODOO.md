# Windows software-printer acceptance: Gateway, Agent and Odoo 19

This document describes the **explicitly authorized** Windows software-queue route. It is a test capability, **not a claim that Microsoft Print to PDF, OneNote or any other virtual printer prints physical paper**. It does not enable local-only inventory automatically or let the Agent credential create a Manager-approved destination.

## Prerequisites and Manager sign-in

1. Install the **matching** Gateway, Windows Agent service and Tauri Desktop binaries from the same verified source/build. Complete pairing to the intended Gateway workspace; note the exact paired Agent ID.
2. Verify the Agent service is running and connected, and the Gateway URL (HTTPS except localhost) is the correct workspace's origin. **Check Connection tests Gateway connectivity, not credentials or printer output.**
3. On Desktop **Manager account**, enter the email and password of a real **Gateway Manager account** with `printers.manage` for this workspace. Agent pairing is not a Manager login. The field also accepts a development username only when the Gateway has that development mode explicitly enabled; `admin` is **not** a guaranteed built-in production credential.
4. The response now distinguishes invalid username/password (`401`), insufficient permission (`403`), throttling (`429`), unavailable Gateway (`5xx`), rejected session and network/TLS problems. Do not paste passwords into issue reports. If the account fails, log into the same Gateway via its normal Manager UI and verify account activation, workspace and roles, then inspect redacted Gateway authentication logs.

## Enable an installed Windows software queue

1. In **Windows Printer settings**, install the queue and note the exact queue name and driver. Windows **Service** accounts and interactive Desktop users may see different queues. A per-user OneNote connection can be invisible to the Agent service. Verify the chosen queue is visible under the **same service account**, and avoid remote-session redirected queues.
2. In Desktop **Printers**, click **Discover**. The **Local virtual printer queues** section shows software queues including Microsoft Print to PDF or OneNote if Windows returned them; being listed **alone** does not authorize Gateway/Odoo jobs.
3. Click **Enable Gateway/Odoo tests** for an eligible installed queue; confirm the warning. The call uses the authenticated Manager session (not the Agent's machine credential), stores desired config `virtual_spooler_test=true`, and requires an active paired Agent.
4. Wait until the Agent has applied the desired revision, the Windows service account has enumerated the **same** queue and heartbeat includes observed `virtual_spooler_test=true`. Until then the UI says **Waiting for Agent confirmation**; failures must be investigated from the Agent desired-state diagnostics. A queue named FAX, redirected from RDP/Citrix, or an unapproved capture cannot be enabled through this route.
5. In the Gateway **Printers** page, select the Manager-owned confirmed queue, then **Send test page**. Inspect the created job ID, its destination, spooler/job status and any generated PDF/OneNote output. `accepted`, `printing` and `success` are **not proof of physical paper**.
6. In Odoo 19, configure the print_gateway integration with the **same tenant's API key**, select the paired Gateway Agent, refresh **runtime printers**, and select the approved queue for a test-safe binding. Run isolated receipt, kitchen/bar ticket and invoice/report test documents using synthetic data. Verify each destination, document contents, selected route, output files and job IDs, without reusing a lost-response operation as a new print intent.
7. Disable or retire the test binding after acceptance if customer orders should not go to an externally stored PDF/OneNote destination. Use an access-restricted profile and never send real sensitive documents to an untrusted software writer.

## Critical Windows limitations

- **Microsoft Print to PDF** commonly asks for an output path in a Save As dialog. A Windows service runs in a non-interactive session and cannot reliably answer that prompt. Even if Winspool allocates a job ID, the resulting PDF **may not appear**. An interactive desktop print or a virtual PDF queue with a configured, unattended output directory is required for unattended file validation.
- **OneNote (Desktop)** can require a signed-in interactive OneNote application/profile; an installed queue may be unusable to LocalSystem. If that queue needs a user session, no source-only Gateway patch can provide one. Choose a service-compatible printer driver or a dedicated safe capture destination.
- The pre-existing Yaseir VirtualCapture software test backend is deliberately separate: it is a Manager-only test-page capture, **not** an Odoo/production destination. For an unattended end-to-end Odoo test, use a **properly configured and approved Windows software spooler queue** which actually writes a deterministic file without UI prompts.
- An application-visible `success` only establishes the strongest documented execution evidence reported by the Agent/spooler. Actual physical paper remains a separate, manually verified fact for physical printers.

## Acceptance checklist (do not prefill PASS)

For each printer and transport record: Windows edition/build, Agent service identity/SID, driver/version, port monitor, exact queue name, printer URI if any, Gateway agent/printer IDs, tenant, manager role, desired/applied revisions, printer capabilities, document and job/operation ID, expected output, spooler job ID when available, observed output file or paper photo, result/error, timestamp and tester.

Test at minimum: valid Manager login, invalid password and locked/revoked role; queued test and Odoo receipt/ticket/invoice; disabled printer; driver missing; stale or disconnected Agent; service restart; duplicate click; dropped response; unauthorized or cross-tenant action; interactive-driver Save prompt. Mark **NOT_RUN** for any condition not actually observed. Only a printer with actual paper can pass a **PHYSICAL_HARDWARE** result.

## Rollback / deployment

- Deploy only through an authorized upgrade window. Keep existing database migrations and printer settings; this change introduces an optional `config.virtual_spooler_test` key, **not a schema migration**.
- Back up the Gateway database and Agent configuration through the documented backup procedure. To revoke this capability, retire the Manager-owned virtual printer in Gateway, remove its Odoo bindings, and wait for Agent desired-state reconciliation. Do not blindly delete queued/unknown jobs, which could make retry evidence ambiguous.
- Before uninstall/rollback, reconcile any pending print attempts and retain their idempotency identities. For rollback to a build without this feature, remove test bindings and retire virtual Managed rows before replacing components; do not downgrade while software destinations still have queued jobs.

Primary documentation: https://learn.microsoft.com/en-us/windows/win32/printdocs/startdocprinter and https://learn.microsoft.com/en-us/windows/win32/services/interactive-services.
