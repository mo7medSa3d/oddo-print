# Troubleshooting Guide

## Agent Issues

### Agent not appearing on Gateway dashboard

**Symptoms**: Agent is running but Gateway shows no agent.

**Checklist**:
1. Verify agent config has a valid `server.url` pointing to the Gateway
2. Verify agent has been registered (has `agent.id` and `agent.secret`)
3. Check agent logs for "Heartbeat rejected" or "WebSocket dial failed"
4. Verify the Gateway URL is reachable from the agent machine
5. Check the API key is valid and the tenant is `active`

### Printers not appearing on Gateway

**Symptoms**: Agent shows printers locally but Gateway shows none.

**Cause**: Printers are reported via heartbeat (every 30s). After manual registration or discovery, wait up to 30 seconds.

**Checklist**:
1. Verify the agent heartbeat is succeeding (no "Heartbeat rejected" in logs)
2. Check for "printer rejected by gateway" log entries
3. Verify the agent is online on the Gateway dashboard
4. Run discovery from the Desktop Manager to force a fresh scan

### Print job stuck in "claimed" status

**Cause**: The agent received the claim but did not report a terminal status.

**Resolution**:
- The gateway's stale-claim sweep runs every 30 seconds. Claims older than 90 seconds without delivery evidence are automatically requeued.
- If a job is stuck longer, check agent logs for the job ID to see if printing is blocking.

### "spooler_rpc_unresponsive" printer status

**Cause**: The Windows Spooler RPC did not respond within the 2-second probe timeout.

**Resolution**:
1. Check if the Windows Print Spooler service is running
2. Restart the Print Spooler service: `net stop spooler && net start spooler`
3. Check if the printer driver is frozen or in an error state

### Agent stops with "CRITICAL: Agent not registered"

**Cause**: The agent config file has no `agent.id`. The agent stays alive waiting for pairing from the Desktop Manager.

**Resolution**: Use the Desktop Manager to pair the agent with the Gateway, or run `agent register` via the CLI.

## Gateway Issues

### "Invalid or missing trust proxy secret" on startup

**Cause**: `TRUST_PROXY_SECRET` is not set or is a known placeholder.

**Resolution**: Set a random string ≥ 32 characters. Configure your reverse proxy to send it in the `X-Gateway-Proxy-Token` header.

### Migration fails with "no unique constraint matching given keys"

**Cause**: Missing `--> statement-breakpoint` separators in migration 0028.

**Resolution**: This was fixed in migration 0041. Ensure all migrations through 0041 are present. See [MIGRATION.md](./MIGRATION.md).

### Jobs delivered but never printed

**Checklist**:
1. Check the agent is online (heartbeat within last 90s)
2. Check the printer status is "online" (not "error" or "offline")
3. Check both counters: `delivery_attempts` may have reached the delivery ceiling, while `retries` may have reached the safe requeue ceiling
4. Check agent logs for the specific job ID
5. Verify the printer protocol matches the payload type (e.g., PDF cannot go to ESC/POS)

## Odoo Integration Issues

### Odoo Agent/Printer dropdowns are empty

**Cause**: The dropdowns call Gateway API endpoints (`/api/odoo/agents`, `/api/odoo/printers`).

**Checklist**:
1. Verify the Gateway Config has a valid URL and API key
2. Test the connection using the "Test Connection" button on the Gateway Config form
3. Verify the Gateway has registered agents (check Gateway dashboard)
4. Check the browser console for API errors
5. Verify the API key has not been revoked

### Odoo login fails with "Session expired (invalid CSRF token)"

**Cause**: The Odoo web client is opened inside a cross-site iframe (embedded
preview, portal, or desktop shell). The login POST is then a cross-site request,
and the `session_id` cookie Odoo sets is `SameSite=Lax` by default, so the
browser does not send it — Odoo sees a POST without a session and rejects the
CSRF token as expired. The error is Odoo's own CSRF guard, not the print addon.

**Resolution**:
1. Serve the web client over HTTPS through the reverse proxy and run Odoo with
   `proxy_mode = True`, so it reads `X-Forwarded-Proto` and marks the session
   cookie `Secure; SameSite=None` (required for embedded/cross-site use).
2. If the browser blocks third-party cookies, open the Odoo URL in its own tab
   so the session cookie is first-party.
3. `SameSite=None` must be paired with `Secure`; over plain HTTP keep Odoo's
   default `Lax` cookie and open the client in a top-level tab instead.

### Report downloads PDF instead of printing via Gateway

**Cause**: No binding exists for the report/destination/company/branch combination.

**Resolution**:
1. Create a binding matching the report, destination, company, and branch
2. Verify the binding is enabled and has a valid agent + printer
3. Check the `print_gateway.binding` list for the expected entry
4. Check the browser console for interceptor errors

### POS receipt printing fails silently

**Checklist**:
1. Verify `pos.session.is_gateway_printing_enabled` returns `true`
2. Verify the POS order has been synced (has a server ID)
3. Check if a binding exists for the POS config with document type "receipt"
4. Check the Odoo server logs for `print_gateway.print_router` errors
5. Verify the rendered receipt image is not empty

### "No canned diagnostic ticket exists for protocol '...'"

**Cause**: Test page generation is only available for `escpos`, `zpl`, `tspl`, and `raw` protocols. Spooler and IPP printers are document transports that require driver-rendered content.

**Resolution**: Use a real report (e.g., invoice) to test end-to-end printing for spooler/IPP printers.

## Performance

### Agent startup takes 8-10 seconds

**Cause**: Full network/USB discovery scans run asynchronously after startup. The initial 2-second delay is intentional.

**Impact**: The agent is functional immediately (serves existing registered printers). New printers appear after discovery completes (~8-10s).

### Heartbeat probe timeouts

**Cause**: Status probes to offline printers may take up to 2 seconds each.

**Impact**: The heartbeat payload may report "spooler_rpc_unresponsive" for unresponsive printers. This is correct behavior — the probe timed out and the status honestly reflects the device state.
