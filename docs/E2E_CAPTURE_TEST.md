# End-to-End Capture Test (Odoo 19 → Gateway → Windows Agent → PDFium)

## What this proves

This is a real **transport and renderer** integration test:

1. An Odoo administrator opens **Yaseir Print → Gateway Configuration → E2E Capture Test**.
2. The administrator selects an **already assigned** Windows Agent (company/branch fenced).
3. Odoo renders a diagnostic PDF, a selected customer-invoice PDF, or accepts an
   Odoo-exported POS/kitchen/bar JPEG. Odoo submits the bounded payload to Gateway
   using the existing installation API key.
4. Gateway authenticates the key and tenant, rechecks live authorization in a
   transaction, reserves an idempotent record in its **separate e2e_capture_runs**
   durable queue, and returns a test run ID.
5. The configured Windows Agent polls its own scoped test queue. A fenced claim
   gives it the document. The Agent uses the existing `CaptureTestDocument` and
   bundled PDFium engine to parse/render the PDF, writing private PDF/PNG evidence.
6. Agent reports PDF SHA-256, bytes, pages and a bounded preview to Gateway with
   the original claim token. Odoo **Refresh Result** reads its own run, displays a
   preview and says **Rendered locally — not printed**.

Neither the printer registry nor `print_jobs`, Odoo print outbox, billing print
usage, hardware printer selection, Windows spooler, or physical-print status is
touched. The Agent *never* fabricates a physical completion. The existing
virtual/software printer filters remain unchanged.

## Explicit opt-in, safe defaults

Both sides default **OFF**. Enable only on a controlled test deployment:

- Gateway environment: `YASEIR_E2E_CAPTURE_ENABLED=1` (passed through the
  `gateway` service in `docker-compose.yml`). Restart the Gateway.
- Agent configuration YAML, under the existing `server:` section:

  ```yaml
  server:
    url: https://print.example.com
    e2e_capture_tests: true
  ```

  Restart the Windows Agent service after saving the protected configuration.
- Do **not** set `YASEIR_AGENT_ALLOW_INSECURE_HTTP`; normal TLS and credential
  validation are unchanged.

Do not share installation API keys in screenshots, logs, or example payloads.
For the dedicated `test/http-server-ready` HTTPS domain staging deployment,
`deploy/domain-test/docker-compose.yml` passes the capture flag to the Gateway
and defaults it to `0` if the staging environment is absent.
`deploy/domain-test/setup-domain-test.sh` initializes it to `1` in the
staging `.env.domain-test` file if not already set (preserving an explicit
`0` opt-out). The production stack remains disabled by default. After
deploying, a credential-free `GET /api/odoo/test-captures` returning HTTP
`401` verifies that the enabled API route exists; `404` indicates the
feature is off or the deployed route is missing. This check does not prove
Agent readiness. Configure `server.e2e_capture_tests: true` on the assigned
Windows Agent separately. Do not relax HTTPS, Caddy, tenant security,
or production printer admission to enable capture testing.

## Windows Manager: safe opt-in without editing YAML

The Manager **Test Center → Incoming Odoo E2E tests** now displays the local
`config.yaml` opt-in state. An elevated Windows Administrator may choose
**Enable receiving tests** / **Disable receiving tests**. The bundled Agent
CLI edits only `server.e2e_capture_tests` in the existing protected YAML,
preserving other entries and comments as well as the separately sealed Agent
secret. No Agent credential or YAML is sent to the desktop WebView.

This control does not automatically restart the Agent, to avoid interrupting
a physical print in flight. After saving the setting, explicitly restart the
Agent service using **Settings → Restart** when no real print jobs are running.
The Gateway feature flag must also be enabled separately. Test Center refreshes
the scoped incoming-test statuses every 10 seconds. The preview is a bounded
JPEG, not the protected local PDF file; printer-free capture never proves that
paper was delivered. Non-admin users see an **Open as Administrator** action
instead of unsafe permissions changes.

Existing deployments keep their prior on/off setting; an upgrade never resets
credentials or silently enables test capture.

## Using Odoo

On an Odoo **19** installation with the current addon, a system administrator
opens **Gateway Configuration → E2E Capture Test**. Choose the correct company,
optionally a branch, then a previously assigned Windows Agent. Select:

- **Odoo PDF test page:** Odoo generates a diagnostic PDF (no real invoice data).
- **Customer invoice:** choose a readable invoice belonging to that scope. Odoo
  renders its own QWeb PDF and sends that exact output.
- **POS / Kitchen / Bar JPEG:** upload the exported JPEG from Odoo POS; choose
  58mm or 80mm. The Agent uses the same receipt-width mapping as production.

Select **Start E2E Test**. Refresh the same dialog to see Queue → Claimed →
Rendered locally or Failed/Expired. If the Agent is offline, the queued run
remains pending until it can safely be claimed or expires (12 minutes).
No page is physically printed.

Odoo 20 is **not yet supported by this addon**. Do not install or force the
Odoo-19 manifest on Odoo 20. The Gateway/Agent API can process valid documents
originating from any version, but Odoo 20 requires its separate supported addon
migration before the UI workflow can be certified.

## Test Center inbox, previews and manual privacy cleanup

Windows Manager **Test Center → Incoming Odoo E2E tests** shows recent
Agent-scoped requests as status cards (queued, claimed/received,
rendered locally, failed, expired). A modal document viewer displays the
bounded **first-page JPEG preview** with fit/zoom and the recorded page count.
There is **no direct `file://` access** to the protected Windows PDFs and no
claim that other pages or physical paper output were displayed.

An elevated Windows Administrator can select **Clear old tests** and confirm
the irreversible operation. Cleanup has two *independent* scopes:

1. **Local:** Delete only private `capture-<24 lowercase hex>.pdf/.png`
   evidence older than two minutes from both
   `%PROGRAMDATA%\\YaseirManager\\test-captures` (legacy root supported)
   and `%PROGRAMDATA%\\YaseirAgent\\e2e-captures` (legacy root supported).
   Reject symlink/junction folder redirection and insecure DACLs; do not remove
   `config.yaml`, pairing secrets, input/other files, printer data, or any
   recently modified capture that might still be in use.
2. **Gateway:** Authenticated `DELETE /api/agent/test-captures/status`
   clears only the paired Agent's own terminal E2E records and requests
   already past their expiry. Queued and claimed non-expired tests remain,
   and **`print_jobs` is never modified**. The endpoint is still usable
   with capture admission turned off, so operators can purge existing test
   payloads after disabling the feature.

These are **best-effort independent cleanups**: if Gateway is offline or
out of date, local files can still be cleared; the UI reports partial
completion rather than incorrectly declaring full success. The normal
48-hour automatic retention still applies when new tests arrive.

### Explaining an inbox HTTP 404

`{"code":"CAPTURE_NOT_ENABLED"}` means
`YASEIR_E2E_CAPTURE_ENABLED=1` is missing on the **deployed Gateway**;
enabling `server.e2e_capture_tests` locally does not change that Gateway
feature flag. A plain/not-recognized 404 means the connected Gateway image
may be older than the inbox feature: deploy the current Gateway build and
restart it, then retry. Do not disable HTTPS or weaken NTFS permissions.

## Gateway Console: Odoo Test Activity

From the authenticated customer Gateway, open **Odoo tests** (`/capture-tests`)
in the Integrations section. This is the tenant's E2E simulation history,
**not** the real print-job queue and not the Windows Agent-only Test Center.

The timeline renders each E2E test as three separately grounded steps:

1. **Gateway received:** Odoo's POST was durably inserted with `queued` status.
   This by itself does not prove the Windows Agent saw the test.
2. **Agent received:** `claimed_at` was written by the Agent polling/claim
   API. The status becomes `claimed` until the final result arrives.
3. **Document verified:** the Agent returned `rendered_locally` with page
   count, size and optional bounded first-page JPEG preview. A `failed`
   or `expired` status reports the error code or timeout instead.

The console shows per-tenant totals, per-Agent filtering, 50-item keyset
pagination, a Refresh button and a 15-second visible-tab refresh. Source
payloads, signed claim tokens, Agent secrets and private Windows paths are
**not** present in the list response. Only roles allowed to read job payloads
can open the protected JPEG preview; it is a **first-page screenshot**, not
the original multi-page PDF or evidence of paper leaving a printer.

Workspace operators with `jobs.cancel` permission may choose **Delete
test** on a terminal test, or **Clear finished tests** with confirmation.
Both are independently tenant-fenced and revalidate the Workspace principal
inside the mutation transaction, with an audit record, a maximum of 200
deleted rows per request, and no impact on active E2E tests, `print_jobs`,
Odoo printer bindings, or Agent configuration. User-visible error messages
distinguish active tests from permission and connectivity failures.

The console remains readable and cleanup stays available even when the
Gateway's `YASEIR_E2E_CAPTURE_ENABLED` flag has been disabled; the page
shows an explicit warning for that case. Gateway cleanup removes stored
Gateway test records and JPEG previews **only**; clearing private PDF/PNG
artifacts on the Windows computer remains an independent operation in the
Agent's Test Center.

## Boundaries and operational protection

- Odoo routes: `POST/GET /api/odoo/test-captures` use the installation API key,
  scope data to its tenant and integration key, and require active billing.
- Agent route: `GET/PATCH /api/agent/test-captures` accepts only the paired
  Agent credential; it returns only work for that Agent and its tenant.
- Production printers never appear in test queue rows. No synthetic virtual
  printer record is created, and Test Center remains separate from Printers.
- PDF/JPEG only; raw, ESC/POS, ZPL/TSPL, peripheral commands and arbitrary
  destinations are rejected. Limit 4 MiB input, 10 PDF pages, 12 minute TTL,
  at most four outstanding runs per Agent and three reclaim attempts.
- Multiple Gateway instances share PostgreSQL claims. SQL locks and an
  unguessable claim token fence stale Agent responses; unfinished test claims
  can be reclaimed safely because no physical side effect is possible.
- On a confirmed result, the database clears the original document payload,
  retaining only sanitized status, checksum and bounded thumbnail. Old run
  records are removed after 48 hours on subsequent admissions.
- On Windows, PDF and PNG outputs are in the protected Agent configuration
  directory under `e2e-captures`, capped at 20 pairs, with cleanup after 48
  hours during subsequent captures. No arbitrary filesystem path is accepted.
- A successful preview proves **end-to-end document transport and PDFium
  rendering**, not Windows spooler delivery or the actual printer's paper exit.
- Physical printer acceptance is a separate test, never inferred from capture.

## Verification gates

- Check the database migration, typecheck, Node contract tests, PostgreSQL
  integration tests, Odoo 19 addon tests, and Go tests including native Windows
  PDFium, all in GitHub Actions for the changed commit.
- Exercise a real Odoo diagnostic PDF and one real exported POS JPEG against a
  paired Agent in staging. Confirm the Gateway never adds a virtual printer,
  `print_jobs`/billing counters do not change, test evidence is scoped, and
  the reported status is `rendered_locally`, not `success` or `printed`.
- Revoke the integration key, retire the Agent, expire the run and re-send stale
  claim results to verify fail-closed behavior before production rollout.
