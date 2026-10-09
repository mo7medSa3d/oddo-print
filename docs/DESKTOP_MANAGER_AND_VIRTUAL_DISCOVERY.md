# Desktop Agent pairing, Gateway connectivity, and Windows printer diagnostics

The installed Yaseir Print Manager desktop no longer asks for a Gateway Manager email or password. It uses the **paired Agent identity** for its own inventory, registration and diagnostic print requests. No production Gateway administrator credentials are stored in the desktop. This is a source-level guide; physical Windows and printer acceptance still require an on-site run.

## Connect the desktop to the Gateway

1. Install the matching Gateway, Agent service, CLI and Tauri desktop release. In **Settings**, enter the HTTPS Gateway origin (for example `https://gateway.example.com`); HTTP is allowed only for explicitly supported loopback development origins.
2. Click **Check Connection**. The public Gateway probe confirms reachability and service identity, **not** Agent registration or a physical print. Failed checks keep the previously saved Gateway origin.
3. Pair the Agent using the one-time pairing code issued from the Gateway workspace. This binds its credentials to that workspace and Gateway origin. The desktop submits authenticated Agent requests through the local native CLI; credentials do not enter the WebView.
4. Once paired and connected, discover physical printers and inspect the jobs owned by that Agent. You can send a **diagnostic test print to one of its own Gateway printers** without Manager login in the desktop. The Gateway verifies both tenant and Agent ownership and re-checks ownership at job admission. The same diagnostic idempotency key must be reused after an ambiguous response.

## Roles and boundaries

- An Agent pairing does **not** grant Gateway workspace Manager or administrator permissions. Use the Gateway **web console** with its normal user/role authentication for workspace-wide printer changes, API keys, Odoo bindings and other administrative operations. A paired Agent may additionally opt in an eligible local Windows software queue for diagnostics, scoped to itself only.
- The desktop does not expose Manager-only workspace edits or retirement actions. **Enable Gateway/Odoo tests** now registers an explicitly selected local virtual queue using the paired Agent identity, without Manager sign-in. The Agent service must verify the exact Windows queue before it can receive jobs.
- A missing or invalid Agent pairing should show a pairing/authorization error. It must never silently fall back to an operator account or forge an authorization header.

## Windows discovery, virtual queues and physical validation

1. Install the Windows printer and verify which user/service account can see the queue. Run **Printers > Discover**. Diagnostic enumeration can include PDF/XPS/OneNote/redirected software queues, but such results are not automatically production destinations.
2. The Agent CLI supports `printers discover --json --include-virtual` for diagnostics. Windows Session-0 service printers may differ from the interactive user's printer inventory. Never infer unattended support from a desktop-only queue.
3. From the desktop **Printers > Local virtual printer queues**, choose **Enable Gateway/Odoo tests**. The Gateway binds the request to the paired Agent, rejects Fax/redirected/capture queues, and sends desired state to the Agent service. Wait for local OS verification; an accepted registration is not permission to print immediately. The Gateway web console remains available for other administrative changes. See [Windows virtual printer Gateway/Odoo guide](WINDOWS_VIRTUAL_PRINTER_GATEWAY_ODOO.md).
4. File-capture testing is separate from actual physical paper. Record the test job ID, identity, document/protocol and observed output. Do not mark printing physically successful without inspecting the printer/output.

## Acceptance checks and deployment

Verify with the target Windows service identity, Gateway/Agent versions and real hardware: Gateway HTTPS, pairing, cross-Agent denial, printer discovery and partial errors, queued/unknown/retried diagnostic IDs, driver/spooler errors, POS 58/80 mm Arabic-English receipts, kitchen/bar partial failures, PDF invoice and supported RAW/IPP/USB transports.

Build matching components from the same revision and pinned dependencies. Back up Gateway and Agent settings/queue data before changing deployments. Do not erase ambiguous print jobs to simulate success, and do not claim Windows or hardware acceptance from static/code-level tests.
