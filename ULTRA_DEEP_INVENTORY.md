# ULTRA-DEEP INVENTORY — Full System Enumeration
Date: 2026-09-21
Branch: arena/01a0c076-oddo-print HEAD 5d5fda1

## GATEWAY — API ROUTES (60)
### Agent Plane (authenticated via agent secret)
- POST /api/agent/register — pairing code -> secret
- POST /api/agent/heartbeat — status online, lastSeenAt
- GET  /api/agent/jobs — poll queued jobs, claim with token
- POST /api/agent/discovery — discovery session create
- GET  /api/agents/[id]/discovery — list sessions
- GET  /api/agents/[id]/discovery/[discoveryId] — get session
- POST /api/agents/[id]/discovery/[discoveryId]/cancel — cancel
- GET  /api/agents/[id]/discovered-printers/[deviceId]/provision — provision
- POST /api/agents/[id]/discovered-printers/[deviceId]/verify — verify

### Manager Console (manager session cookie / Bearer)
- GET  /api/agents — list agents
- GET  /api/agents/[id] — get agent
- PATCH/DELETE /api/agents/[id] — lifecycle, delete
- GET  /api/printers — list printers
- POST /api/printers — create printer (manager)
- GET/PATCH/DELETE /api/printers/[id] — printer lifecycle, config
- POST /api/printers/[id]/test-print — real job queued->claimed->printing->success/failed
- POST /api/printers/[id]/test-connection — test connectivity
- GET  /api/jobs — list jobs filtered
- GET  /api/jobs/[id] — get job with payload
- POST /api/print/jobs — Odoo job creation (see Odoo plane)
- POST /api/print/jobs/batch-status — batch status
- GET  /api/live — live events? (check)
- GET  /api/metrics — prometheus
- GET  /api/health — health probe
- POST /api/settings — settings save
- GET  /api/billing/plans — plans
- POST /api/billing/checkout — checkout session
- POST /api/billing/portal — portal session (fixed randomUUID)
- POST /api/billing/cancel — cancel
- POST /api/billing/resume — resume
- POST /api/billing/webhook — Stripe webhook idempotent
- GET  /api/auth/me — customer me
- POST /api/auth/login — customer login
- POST /api/auth/logout — logout
- POST /api/auth/register — register
- POST /api/auth/verify-email — verify
- POST /api/auth/forgot-password — forgot
- POST /api/auth/reset-password — reset
- POST /api/auth/resend-verification — resend
- POST /api/auth/select-tenant — select tenant (multi-tenant)
- POST /api/auth/manager/login — manager login
- POST /api/auth/manager/logout — manager logout
- GET  /api/auth/manager/me — manager me
- POST /api/team/invitations — invite
- POST /api/team/invitations/accept — accept
- GET  /api/team/members — list members
- POST /api/team/ownership — transfer ownership
- POST /api/onboarding — onboarding
- GET  /api/admin/tenants/[id]/lifecycle — lifecycle?

### Odoo Plane (odoo_ API key)
- GET  /api/odoo/printers — list printers for agent_id
- POST /api/print/jobs — create job (Odoo)
- GET  /api/odoo/agents — list agents
- GET  /api/odoo/configuration — gateway config
- GET  /api/odoo/health — health with tenant lifecycle
- GET  /api/odoo/keys — list keys
- POST /api/odoo/keys/[id]/rotate — rotate key
- GET  /api/odoo/printers?agent_id — printers for Odoo

### Platform Admin (platform owner)
- POST /api/platform/auth/login
- POST /api/platform/auth/logout
- GET  /api/platform/tenants
- POST /api/platform/tenants/[id]/suspend
- POST /api/platform/tenants/[id]/reactivate
- GET  /api/platform/plans
- POST /api/platform/plans
- GET/PATCH /api/platform/plans/[id]
- GET  /api/platform/subscriptions
- GET  /api/platform/stats
- GET  /api/platform/audit

### Server Actions (src/app/actions.ts)
- createAgent(name)
- deleteAgent(id)
- createPrintJob(printerId, payload)
- reprintJob(jobId)
- setPrinterLifecycle(id, lifecycle)
- setAgentLifecycle(id, lifecycle)
- getDashboardState()
- getDashboardJobs(options: status, search, limit)

### Shared Backend Helpers (src/lib)
- agent-auth.ts — pairing code alphabet, hashSecret, hashPairingCode, generateSecret, validateAgent
- agent-availability.ts — stale threshold 90s, isAgentOnline
- agent-lifecycle.ts — lifecycle transitions
- agent-presence-maintenance.ts — presence sweep
- audit.ts — writeAuditEvent
- auth-rate-limit.ts — rate limiting
- authorization.ts — hasManagerPermission, requireManagerPermission
- canonicalize.ts — canonicalize for idempotency fingerprint
- clipboard.ts — copyTextToClipboard
- console-auth.ts — validateConsoleAuth (manager or agent)
- customer-auth.ts — tenant selection token HS256, authenticateForTenant, issueCustomerSession
- discovery.ts — discovery session helpers
- email.ts — send email
- entitlements.ts — normalizePlanEntitlements, getTenantEntitlementLimit, enforceTenantResourceEntitlement, enforceTenantJobEntitlements
- job-delivery.ts — claimJobForDelivery, markJobDelivered, recordJobAck, releaseUndeliveredClaim, MAX_AGENT_IN_FLIGHT_JOBS 500, CLAIM_LEASE_SECONDS 90
- job-fencing.ts — fencedJobWrite, fencedDeliveryWrite
- job-maintenance.ts — sweepPrintJobs, STALE_CLAIM 90s, STALE_PRINTING 10m, MAX_RETRIES 5, MAX_DELIVERY_ATTEMPTS 5
- job-status.ts — JOB_STATUSES closed, PHYSICAL_OUTCOMES, derivePhysicalOutcome, isTerminal, canTransition, AGENT_REQUEUE_REASONS, LATE_SUCCESS
- lifecycle.ts — tenant lifecycle?
- log.ts — logInfo, logError
- manager-auth.ts — authenticateCustomer, createManagerSession, managerCookieHeader, validateManager
- manager-session-tx.ts — session tx helpers
- metrics.ts — incrementMetric, gatewayMetrics table
- nanoid.ts — nanoid
- network-address.ts — IP validation
- odoo-auth.ts — generateOdooApiKey, isOdooKeyAllowedForDocumentType, validateOdooKey
- password.ts — hash, verify, normalizeEmail
- payload.ts — validatePrintJobPayload, buildTestPrintPayloadForPrinter
- platform-auth.ts — platform owner auth
- print-job-service.ts — idempotencyFingerprint, createPrintJobForPrinter, insertQueuedJobAtomically, MAX_AGENT_QUEUED_JOBS 256, MAX_AGENT_QUEUED_PAYLOAD_BYTES 128MiB, AgentQueueFullError, PrintJobInputError
- printer-model.ts — printer model helpers
- printer-virtual.ts — isVirtualPrinterRecord
- request-limits.ts — request body limits
- routing.ts — isPrinterStatusExecutable, validatePayloadForPrinter
- runtime-secret.ts — requiredRuntimeSecret, runtimeSecret
- stripe.ts — stripeRequest, verifyStripeSignature
- tenant-guard.ts — requireActiveTenant, TenantSuspendedError, TenantDeletedError
- tenant-lifecycle.ts — transitionTenantLifecycle, FOR UPDATE lock, state machine
- utils.ts — utils
- worker-schema.ts — worker schema
- ws-rate-limit.ts — ws rate limit

### DB Services (src/db)
- index.ts — db, pool
- schema.ts — all tables: tenants, tenant_domains, users, platform_sessions, tenant_users, applications, agents, printers, apiKeys, managerSessions, emailVerificationTokens, passwordResetTokens, tenantInvitations, billingEvents, authRateLimits, discoverySessions, discoveredDevices, printJobs, gatewayMetrics, auditEvents, plans, tenantSubscriptions, printJobRateLimits
- tenant.ts — withTenant set_config app.current_tenant

### Background Workers / Maintenance
- src/lib/job-maintenance.ts sweepPrintJobs — expired, requeuedClaims, silentDeliveries, stalePrinting, exhaustedClaims, exhaustedQueued — batch 200 SKIP LOCKED
- src/lib/agent-presence-maintenance.ts — presence sweep
- src/server/ws.ts — WebSocket server, claim delivery, session fencing, socket cap, listener setup race handling
- Odoo cron: odoo_addons/print_gateway/data/cron.xml — print_job cleanup? Check

### Auth Helpers
- customer-auth, manager-auth, agent-auth, odoo-auth, platform-auth, console-auth, tenant-guard

### Tenant Helpers
- tenant.ts withTenant, tenant-guard requireActiveTenant, tenant-lifecycle transitionTenantLifecycle

### Queue Helpers
- job-delivery claimJobForDelivery, job-maintenance sweep, print-job-service admission

### Billing Helpers
- stripe.ts, entitlements.ts, billing routes checkout/portal/cancel/resume/webhook

### Integration Helpers
- discovery.ts, routing.ts, payload.ts, printer-virtual.ts, printer-model.ts

## ODOO — Full Inventory
### Models (odoo_addons/print_gateway/models)
- gateway_config.py — Gateway Configuration, company_id, enabled, gateway_url, gateway_api_key (encrypted), gateway_sync_state (active/syncing/attention/disabled/not_configured), gateway_sync_message, odoo_enabled replication, action_test_connection, action_open_pairing_wizard, action_open_runtime_assignments, action_clear_api_key
- print_job.py — print_gateway.print_job outbox, status queued/claimed/printing/success/failed/expired/unknown, physical outcome mapping, retry, sync to Gateway
- print_intent.py — intent?
- print_policy.py — policy binding?
- binding.py — binding between Odoo doc and printer?
- print_router.py — routing logic agent/printer selection
- runtime_assignment.py — Branch Assignments (runtime agent to branch)
- account_move.py — invoice printing
- pos_order.py — POS receipt printing
- pos_session.py — POS session
- ir_actions_report.py — report interceptor
- stock_picking.py — stock picking printing
- crypto.py — encryption for api key

### Controllers
- pos.py — POS printing controller
- runtime_printers.py — runtime printers API?

### Views
- gateway_config_views.xml — list (Gateway Status badge), form (header Test Connection/Pair New Agent/Branch Assignments, distinct state row credential/activation/connection with invisible, groups Connection, alert warning invisible attention)
- binding_views.xml
- print_intent_views.xml
- print_job_views.xml
- print_policy_views.xml
- runtime_assignment_views.xml
- menu.xml

### Wizards
- pair_agent_wizard (in gateway_config_views.xml) — Assign Runtime Agent, branch_id, agent_id

### JS/Owl Components
- runtime_agent_field.js
- runtime_printer_field.js
- pos_print_router.js — POS print router
- pos_sale_details_router.js — sale details
- report_interceptor.js — report printing
- tours/binding_cascade_tour.js — tour

### Asset Bundles
- print_gateway_backend.scss
- print_gateway_tokens.scss

### Security
- ir.model.access.csv
- security.xml

### Cron
- cron.xml — check content

### Migrations
- 1.1.0/pre-migrate.py
- 19.0.1.1.0/pre-migrate.py
- 19.0.2.1.0/post-migrate.py
- 19.0.2.3.0/post-migrate.py
- 19.0.2.4.0/post-migrate.py

### Print Routes
- POS receipt, kitchen, sale details, reports, stock, invoices — via pos_order, stock_picking, account_move, ir_actions_report

### Synchronization Paths
- Gateway config sync: Odoo -> Gateway via /api/odoo/configuration? and /api/odoo/health?
- Print job: Odoo outbox -> Gateway /api/print/jobs -> Agent -> status back -> Odoo reconciliation
- Runtime assignments: Odoo -> Gateway agents/printers

## AGENT — Full Inventory
### Packages
- internal/agent — main agent logic, pairing, discovery_manager, desired_state, dispatch, ws_delivery
- internal/config — config.yaml, paths, security (windows/other), replace_file
- internal/diag — diagnostics
- internal/integration — crash_test, failure_test, mock_e2e_test
- internal/payload — payload validation, bench
- internal/printer — capability, classify, classify_device, discovery, discovery_extended, discovery_windows/other, document, factory, health, image, ipp, ipp_discovery, network, network_discovery, outcome, pdf, peripherals, printer, raster_capability, registry, snmp_discovery, spooler_windows/stub, stable_id, usb_windows/other, wsd_discovery
- internal/queue — cleanup, queue (SQLite), bench
- internal/storage — replace_file, secure, security
- internal/testutil — mock_printer
- cmd/agent — main.go entrypoint
- cmd/cli — cleanup, gateway (gateway-request), helpers, main.go

### Executable Entrypoints
- agent/cmd/agent/main.go — agent daemon
- agent/cmd/cli/main.go — CLI for pairing, printers discover/add/test, gateway-request, cleanup

### Goroutine Producer/Consumer
- Need to inspect agent.go: heartbeat loop, job poll loop, WS reconnect loop, discovery sessions, printer health, queue processor, lease keep-alive

### Queues
- internal/queue/queue.go — SQLite durable queue, BeginPrint, etc.

### Persistence Paths
- agent_data_root, printers.json, queue.db, config.yaml, logs

### Printer Backends
- RAW, ESC/POS, ZPL, TSPL, IPP/IPPS, Spooler (Windows), USB, Network, PDF, Image

### Network Transports
- WS to Gateway (jobs, heartbeat), HTTP for pairing, gateway-request via CLI

### Reconnect Loops
- WS reconnect with backoff, heartbeat 30s?, claim lease 90s

### Heartbeat Path
- agent.go heartbeat -> /api/agent/heartbeat, lastSeenAt update, status online

### Job Execution Path
- claim -> local ledger -> printer backend -> status update -> ack -> Gateway -> Odoo

## DESKTOP — Full Inventory
### Tauri Commands (src-tauri/src/commands.rs)
- is_running_as_admin
- get_agent_status
- start_agent
- stop_agent
- restart_agent
- control_service
- pair_agent
- get_gateway_config
- set_gateway_config
- get_runtime_paths
- get_app_version
- get_printers
- discover_printers
- test_printer
- register_printer
- get_autostart
- set_autostart
- gateway_request — manager transport, origin check, header budget, body limit, method allowlist, token in Rust memory
- gateway_agent_request — agent console allowlist, printer id validation, jobs query validation, bounded
- clear_manager_session
- has_manager_session

### Capabilities (src-tauri/capabilities/default.json)
- 21 permissions: core:default, allow-get-agent-status, allow-start-agent, allow-stop-agent, allow-restart-agent, allow-control-service, allow-pair-agent, allow-get-gateway-config, allow-set-gateway-config, allow-gateway-request, allow-gateway-agent-request, allow-clear-manager-session, allow-has-manager-session, allow-get-runtime-paths, allow-get-app-version, allow-get-printers, allow-discover-printers, allow-test-printer, allow-cleanup-local-jobs, allow-register-printer, allow-get-autostart, allow-set-autostart
- windows ["main"]

### IPC Calls (src/desktop/lib/ipc.ts)
- getAgentStatus, startAgent, stopAgent, restartAgent, pairAgent, getGatewayUrl, setGatewayUrl, getRuntimePaths, getAppVersion, isRunningAsAdmin, closeApp, fetchGatewayAgents, fetchGatewayPrinters, registerGatewayPrinter, updateGatewayPrinter, getPrinters, discoverPrinters, testGatewayPrinter, cleanupLocalJobs, registerPrinter, getAutostart, setAutostart, fetchGatewayJobs, fetchGatewayHealth, loginManager, getManagerSession, logoutManager, isManagerAuthenticated, onManagerAuthChanged, onTrayRestartAgent, onTrayNavigate, onGatewayConfigChanged, gatewayRequest, gatewayConsoleRequest, normalizeGatewayUrl

### Pages
- Overview.tsx
- Agents.tsx
- Jobs.tsx
- Printers.tsx
- Settings.tsx

### Actions
- AddPrinterDialog, EditPrinterDialog, AdminPrivilegeDialog, JobTimeline, Sidebar

### System/Service Control
- src-tauri/src/agent.rs — status via sc query, tasklist, start/stop/restart via sc.exe, CLI path, bounded command 30s 64KiB
- autostart via tauri_plugin_autostart, marker file autostart-user-choice

### File Access
- settings_path, agent_config_path, manager_data_root, manager_log_path, agent_data_root, printers.json, queue.db

### Process Execution
- run_bounded_command, Command::new CLI with -pair, -server, -config, gateway-request, printers discover/add/test, cleanup

## DEPLOYMENT
### Docker
- Dockerfile — multi-stage Node 24, Go build, Rust? Check
- docker-compose.yml — gateway, postgres, caddy, etc.
- Caddyfile — encode gzip zstd, request_body max 8MiB, reverse_proxy gateway:3000 with header_up Host, X-Gateway-Proxy-Token from secret, X-Forwarded-For, -X-Real-Ip
- .env.example — secrets
- next-env.d.ts

### CI
- .github/workflows/ci.yml
- .github/workflows/build-windows.yml
- .github/workflows/docker.yml
- .github/workflows/security-supply-chain.yml

### Installer
- src-tauri/tauri.conf.json — bundler, icons, resources
- src-tauri/installer_hooks.nsh — NSIS hooks

### Windows Service Installer
- Check agent/Makefile, service registration via sc.exe?

### Service Configuration
- Caddy TLS, trusted proxy token, runtime-secret

### Runtime Paths
- src-tauri/src/paths.rs — manager_data_root, settings_path, agent_config_path, manager_log_path, agent_data_root

