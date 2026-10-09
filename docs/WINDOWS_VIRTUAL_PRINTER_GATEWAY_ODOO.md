# Windows virtual printer acceptance through Gateway, Agent and Odoo 19

Software queues such as Microsoft Print to PDF, XPS, OneNote or a redirected printer **do not prove physical paper output**. Virtual printing is opt-in, and an Agent must never self-approve a Manager-controlled software destination.

## Setup and approval

1. Install matching Gateway, Windows Agent service, CLI and desktop binaries. In desktop **Settings**, save/verify the HTTPS Gateway origin and pair the Agent to its intended workspace. **There is no Manager sign-in field in the desktop.**
2. Identify the Windows service account that runs the Agent and verify that the installed spooler queue is visible and can operate in that noninteractive account. Desktop **Printers > Discover** can show virtual queues for *local diagnostics only*.
3. To enable a software spooler for Gateway/Odoo tests, sign in to the **Gateway web console** with a workspace Manager permitted to manage printers. Create/approve the test-specific virtual printer in that interface, with `virtual_spooler_test=true` and a genuine installed spooler queue. This is a Gateway Manager action, **not** an Agent Desktop action.
4. Wait for the Agent to apply the authorized desired state and confirm it observes the same Windows queue. Pending or unobserved virtual destinations must not be presented as ready for printing.
5. Use **Send test page** from the Gateway console or the paired Agent desktop's **Test Print** action on its *own confirmed printer*. The desktop path uses the paired Agent identity, bounded idempotency key and Gateway ownership check; it cannot access another Agent's printer.
6. In Odoo 19, use the **same workspace's** Gateway integration credentials, select the correct Agent, refresh runtime printers and bind only the approved test destination. Send synthetic receipts, preparation tickets and invoice/reports; verify actual output files and job/status evidence.

## Windows and print-path limitations

- **Microsoft Print to PDF** often displays an interactive Save As prompt and may fail when invoked by a Windows service. A spooler job ID or successful submission alone does not establish that a PDF file appeared.
- **OneNote** may depend on a user session and profile; RDP-redirected, fax and other software queues can be unavailable in Session 0. Confirm service-compatible unattended operation before use.
- The Yaseir VirtualCapture test backend is a separately gated diagnostic sink, not an arbitrary customer/Odoo production destination. Never route sensitive real customer data to a disposable or untrusted software queue.
- Print state `queued`, `printing` and even `success` is not direct observation of paper leaving a physical printer.

## Security and acceptance

The Gateway web Manager still needs its normal role-based login for administrative approvals. The paired Agent is scoped to its tenant, Agent ID and printer. Confirm unauthorized/cross-Agent denial, stale or disabled printer, rate/quota limits, 401/403 cases, duplicate clicks, lost HTTP responses and replay of the same operation ID, as well as Odoo document mapping and physical or generated-file evidence.

For acceptance, record Windows version, account SID, queue/driver/port, Gateway tenant/Agent/printer identity, desired/applied state, job ID, output and error, timestamp and tester. Mark any unexercised hardware check **NOT_RUN**, not PASS.

## Rollback

Back up Gateway/Agent configuration and database before changing a live environment. Retire or disable virtual test destinations through the Gateway, unbind Odoo test rules and reconcile pending/ambiguous jobs before rollback. Never delete unknown outcomes merely to clear a dashboard.

Windows printing references: https://learn.microsoft.com/en-us/windows/win32/printdocs/startdocprinter and https://learn.microsoft.com/en-us/windows/win32/services/interactive-services.
