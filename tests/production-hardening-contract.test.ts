import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hasBodyOverLimit } from "../src/lib/request-limits";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

describe("production hardening contracts", () => {
  it("uses the transactional tenant lifecycle fence on runtime/control writes", () => {
    expect(read("src/lib/tenant-guard.ts")).toContain("requireActiveTenantInTransaction");
    expect(read("src/lib/tenant-guard.ts")).toContain("FOR SHARE");
    expect(read("src/lib/agent-lifecycle.ts")).toContain("requireActiveTenantInTransaction(tx, tenantId)");
    expect(read("src/app/actions.ts")).toContain("requireActiveTenantInTransaction(tx, manager.tenantId)");
    expect(read("src/app/api/agent/register/route.ts")).toContain("requireActiveTenantInTransaction(tx, agent.tenantId)");
    expect(read("src/app/api/agent/heartbeat/route.ts")).toContain("requireActiveTenantInTransaction(tx, agent.tenantId)");
    expect(read("src/app/api/agent/discovery/route.ts")).toContain("requireActiveTenantInTransaction(tx, agent.tenantId)");
    expect(read("src/app/api/agents/[id]/discovered-printers/[deviceId]/provision/route.ts")).toContain("requireActiveTenantInTransaction(tx, claims.tenantId)");
    expect(read("src/app/api/printers/[id]/route.ts")).toContain("requireActiveTenantInTransaction(tx, tenantId)");
  });

  it("rejects declared request bodies over the endpoint limit", () => {
    expect(hasBodyOverLimit(new Request("http://test", { headers: { "content-length": "1024" } }), 2048)).toBe(false);
    expect(hasBodyOverLimit(new Request("http://test", { headers: { "content-length": "2049" } }), 2048)).toBe(true);
    expect(hasBodyOverLimit(new Request("http://test", { headers: { "content-length": "-1" } }), 2048)).toBe(true);
    expect(hasBodyOverLimit(new Request("http://test", { headers: { "content-length": "1e3" } }), 2048)).toBe(true);
    expect(hasBodyOverLimit(new Request("http://test", { headers: { "content-length": "0x10" } }), 2048)).toBe(true);
    expect(hasBodyOverLimit(new Request("http://test", { headers: { "content-length": "1.5" } }), 2048)).toBe(true);
    expect(hasBodyOverLimit(new Request("http://test", { headers: { "content-length": "9007199254740993" } }), Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(hasBodyOverLimit(new Request("http://test"), 2048)).toBe(false);
  });

  it("fences agent-driven expiration at the database clock", () => {
    const route = read("src/app/api/agent/jobs/route.ts");
    const jobStatus = read("src/lib/job-status.ts");
    expect(jobStatus).toContain('claimed: new Set(["printing", "failed", "queued"])');
    expect(jobStatus).toContain('printing: new Set(["success", "failed"])');
    expect(route).toContain('if (requestedStatus !== "expired" && job.claimToken && claimToken !== job.claimToken)');
    expect(route).toContain('requestedStatus === "expired"');
    expect(route).toContain('fencedJobWrite(jobId, agent.tenantId, agent.id, currentStatus, claimToken)');
    expect(route).toContain('sql`${printJobs.expiresAt} <= now()`');
    expect(route).toContain('code: "JOB_NOT_EXPIRED_OR_STALE"');
    expect(route).toContain('JOB_EXPIRED_DURING_PRINT: physical output is unknown');
    expect(route).toContain('UNKNOWN_PARTIAL_DELIVERY: job expired after delivery without an execution report');
  });

  it("does not log Odoo print-intent claim tokens", () => {
    const intent = read("odoo_addons/print_gateway/models/print_intent.py");
    expect(intent).not.toContain('token %s: %s", intent_id, claim_token, exc');
    expect(intent).not.toContain('claim_token, exc)');
  });

  it("keeps the API body guard stream-safe without request cloning", () => {
    const server = read("server.ts");
    const guard = read("src/server/request-guard.ts");
    expect(server).toContain("guardApiRequest(req, res)");
    expect(server).not.toContain('req.on("data"');
    expect(guard).toContain("export const MAX_API_BODY_BYTES = 8 * 1024 * 1024;");
    expect(guard).toContain('const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"];');
    expect(guard).toContain("REQUEST_BODY_TOO_LARGE");
    expect(guard).toContain("MAX_CONCURRENT_CHUNKED_BYTES");
    expect(guard).not.toContain("cloneRequestWithBody");
    expect(guard).not.toContain("new IncomingMessage");
    expect(guard).toContain("CONTENT_LENGTH_REQUIRED");
  });

  it("keeps the bundled Caddy sanitizing forwarded-IP headers and capping request bodies", () => {
    const caddy = read("Caddyfile");
    expect(caddy).toContain("header_up X-Forwarded-For {http.request.remote.host}");
    expect(caddy).toContain("header_up -X-Real-Ip");
    expect(caddy).toContain("max_size 8MiB");
  });

  it("fails closed in production when the platform tenant identity is not configured", () => {
    const server = read("server.ts");
    expect(server).toContain('runtimeSecret("PLATFORM_TENANT_ID")?.trim()');
    expect(server).toContain("<required-platform-tenant-id>");
    expect(server).toContain("PLATFORM_TENANT_ID must be configured with the real platform workspace ID");
    expect(server).toContain("Refusing production startup");
  });

  it("keeps Docker migration out of runtime startup and orders Compose migration before gateway", () => {
    const dockerfile = read("Dockerfile");
    const compose = read("docker-compose.yml");
    expect(dockerfile).toContain('CMD ["npm", "start"]');
    expect(dockerfile).not.toContain("npm run db:migrate && npm start");
    expect(compose).toContain("migrate:");
    expect(compose).toContain('command: ["npm", "run", "db:migrate"]');
    expect(compose).toContain("service_completed_successfully");
    expect(compose).toContain("condition: service_healthy");
    expect(compose).toContain("PGHOST: postgres");
    expect(compose).toContain("PGPASSWORD_FILE: /run/secrets/postgres_password");
    expect(compose).not.toContain("PGPASSWORD: ${POSTGRES_PASSWORD");
    expect(compose).not.toContain("DATABASE_URL: postgresql://");
    expect(read("src/db/index.ts")).toContain("runtimeSecret(\"PGPASSWORD\")");
    expect(read("src/lib/runtime-secret.ts")).toContain("${name}_FILE");
    expect(read("scripts/db-migrate.ts")).toContain("hasDatabaseSettings");
  });

  it("scopes Agent-generated printer and discovery identities to the tenant", () => {
    const schema = read("src/db/schema.ts");
    const printersBlock = schema.slice(schema.indexOf("export const printers = pgTable"));
    const printersTable = printersBlock.slice(0, printersBlock.indexOf("export const apiKeys"));
    expect(printersTable).toContain("id: text(\"id\").notNull()");
    expect(printersTable).not.toContain("id: text(\"id\").primaryKey()");
    expect(printersTable).toContain("unique(\"printers_tenant_id_unique\")");

    const discoveredBlock = schema.slice(schema.indexOf("export const discoveredDevices = pgTable"));
    const discoveredTable = discoveredBlock.slice(0, discoveredBlock.indexOf("export const printJobs"));
    expect(discoveredTable).toContain("id: text(\"id\").notNull()");
    expect(discoveredTable).not.toContain("id: text(\"id\").primaryKey()");
    expect(discoveredTable).toContain("unique(\"discovered_devices_tenant_id_unique\")");

    const heartbeat = read("src/app/api/agent/heartbeat/route.ts");
    expect(heartbeat).toContain("onConflictDoNothing({ target: [printers.tenantId, printers.id] })");
    expect(heartbeat).not.toContain("onConflictDoNothing({ target: printers.id })");

    const discovery = read("src/app/api/agent/discovery/route.ts");
    expect(discovery).toContain("onConflictDoNothing({ target: [discoveredDevices.tenantId, discoveredDevices.id] })");

    const migration = read("drizzle/0072_tenant_scoped_printer_identity.sql");
    expect(migration).toContain("DROP CONSTRAINT IF EXISTS \"printers_pkey\"");
    expect(migration).toContain("DROP INDEX IF EXISTS \"printers_gateway_id_global_unique\"");
    expect(migration).toContain("DROP CONSTRAINT IF EXISTS \"discovered_devices_pkey\"");
  });

  it("keeps Drizzle journal entries unique and aligned with migration files", () => {
    const journal = JSON.parse(read("drizzle/meta/_journal.json")) as { entries: Array<{ tag: string }> };
    const tags = journal.entries.map((entry) => entry.tag);
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags).toContain("0012_runtime_state_checks");
    expect(tags).toContain("0013_runtime_state_constraint_scope_fix");
    expect(tags).toContain("0014_discovery_state_checks");
    expect(tags).toContain("0015_metrics_and_agent_notifications");
    expect(tags).toContain("0016_print_job_rate_limits");
    expect(tags).toContain("0017_notify_requeued_jobs");
    expect(tags).toContain("0021_scope_print_jobs_to_api_key");
    expect(tags).toContain("0049_tenant_scoped_idempotency_and_owner_unique");
    expect(read("drizzle/0013_runtime_state_constraint_scope_fix.sql")).toContain("current_schema()");
    expect(read("drizzle/0014_discovery_state_checks.sql")).toContain("discovered_devices_candidate_status_check");
  });

  it("does not silently restore the old auto-provision discovery path", () => {
    const provision = read("src/app/api/agents/[id]/discovered-printers/[deviceId]/provision/route.ts");
    const verify = read("src/app/api/agents/[id]/discovered-printers/[deviceId]/verify/route.ts");
    expect(provision).toContain('code: "DEVICE_NOT_APPROVED"');
    expect(provision).toContain('row.verification !== "verified"');
    expect(provision).toContain("UNSUPPORTED_DISCOVERY_TRANSPORT");
    expect(provision).not.toContain('wsd: "raw"');
    expect(provision).not.toContain('mdns: "ipp"');
    expect(provision).not.toContain('snmp: "raw"');
    expect(provision).not.toContain('usb: "raw"');
    expect(verify).toContain('verification: "verified"');
    expect(verify).toContain('candidateStatus: "verified"');
  });

  it("keeps the dashboard focused on runtime agents, printers, and jobs", () => {
    const dashboard = read("src/app/dashboard/dashboard-client.tsx");
    expect(dashboard).toContain("Runtime Printers");
    expect(dashboard).toContain("Recent Print Jobs");
    expect(dashboard).not.toContain("candidateStatus");
    expect(dashboard).not.toContain("Technical confidence remains unchanged");
  });

  it("does not silently discard drawer-kick transport failures", () => {
    const agent = read("agent/internal/agent/agent.go");
    expect(agent).toContain("peripheral_drawer_kick_failed");
  });

  it("keeps tenant scoping fail-closed in manager dashboard and agent lifecycle routes", () => {
    const dashboard = read("src/app/dashboard/page.tsx");
    const lifecycle = read("src/app/api/agents/[id]/route.ts");
    const helper = read("src/lib/agent-lifecycle.ts");
    expect(dashboard).toContain("eq(agents.tenantId, claims.tenantId)");
    expect(dashboard).toContain("eq(printers.tenantId, claims.tenantId)");
    expect(dashboard).toContain("eq(printJobs.tenantId, claims.tenantId)");
    expect(lifecycle).toContain("transitionAgentLifecycle(id, lifecycle, claims.tenantId, {");
    expect(helper).toContain("eq(agents.tenantId, tenantId)");
    expect(helper).not.toContain("tx.update(printers)");
  });

  it("keeps stock validation automated policy dispatch centralized", () => {
    const stock = read("odoo_addons/print_gateway/models/stock_picking.py");
    expect(stock).toContain("dispatch_for_record");
    expect(stock).toContain("\"picking_validated\"");
    expect(stock).not.toContain("resolve_for_record");
    expect(stock).not.toContain("effective_target_key");
    expect(stock).not.toContain("create_and_route(policy, picking");
  });

  it("keeps Gateway job expiry validation on PostgreSQL clock", () => {
    const service = read("src/lib/print-job-service.ts");
    const route = read("src/app/api/print/jobs/route.ts");
    expect(service).toContain("clock_timestamp()");
    expect(service).toContain("expiresAt must be in the future");
    expect(service).not.toContain("new Date(Date.now() + 60 * 60 * 1000)");
    expect(service).not.toContain("expiresAt.getTime() <= Date.now()");
    expect(route).not.toContain("const now = Date.now()");
    expect(route).not.toContain("parsed.getTime() <= now");
  });

  it("keeps direct print submission printer-scoped and payload-validated", () => {
    const route = read("src/app/api/print/jobs/route.ts");
    expect(route).toContain("validatePrintJobPayload(parsed.data.payload)");
    expect(route).toContain("printerId");
    expect(route).not.toContain("branchId");
    expect(route).not.toContain("branch_id");
    expect(route).not.toContain("destinationId");
  });

  it("keeps agent lifecycle auditing single-writer and selection-token consumption conflict-safe", () => {
    const actions = read("src/app/actions.ts");
    const lifecycleStart = actions.indexOf("export async function setAgentLifecycle");
    const lifecycleEnd = actions.indexOf("export async function getDashboardState");
    expect(lifecycleStart).toBeGreaterThanOrEqual(0);
    expect(lifecycleEnd).toBeGreaterThan(lifecycleStart);
    const lifecycleAction = actions.slice(lifecycleStart, lifecycleEnd);
    expect(lifecycleAction).not.toContain("writeAuditEvent");
    expect(lifecycleAction).toContain("transitionAgentLifecycle");

    const selectTenant = read("src/app/api/auth/select-tenant/route.ts");
    expect(selectTenant).toContain("onConflictDoNothing");
    expect(selectTenant).toContain("returning({ key: authRateLimits.key })");
    expect(selectTenant).toContain("Selection token already used");
    expect(selectTenant).not.toContain(`catch {
          throw new Error("Selection token already used")`);
  });

  it("keeps control-plane concurrency boundaries enforced by code and schema", () => {
    const invitation = read("src/app/api/team/invitations/accept/route.ts");
    expect(invitation).toContain("FROM tenants");
    expect(invitation).toContain("FOR UPDATE");
    expect(invitation).toContain("tenantRow.lifecycle !== \"active\"");
    expect(invitation).toContain('action: "team.invitation.accepted"');
    expect(invitation).toContain("}, tx);");

    const onboarding = read("src/app/api/onboarding/route.ts");
    expect(onboarding).toContain("await tx.update(tenants)");
    const trialLock = onboarding.indexOf("await tx.update(tenants)");
    const trialRead = onboarding.indexOf("const existing = await tx.query.tenantSubscriptions.findFirst");
    expect(trialLock).toBeGreaterThanOrEqual(0);
    expect(trialRead).toBeGreaterThan(trialLock);
    expect(onboarding).toContain("Trial has already been used for this workspace");

    const checkout = read("src/app/api/billing/checkout/route.ts");
    expect(checkout).toContain("FROM tenants");
    expect(checkout).toContain("FOR UPDATE");
    expect(checkout).toContain("tenant-customer-");
    expect(checkout).toContain("checkout-intent-");
    expect(checkout).toContain('checkoutStatus: "creating"');
    expect(checkout).toContain("checkoutIdempotencyKey");
    expect(checkout).toContain("billingOperationId");

    const lifecycle = read("src/lib/tenant-lifecycle.ts");
    expect(lifecycle).toContain('PLATFORM_TENANT_PROTECTED');
    
    const discovery = read("src/app/api/agents/[id]/discovery/route.ts");
    expect(discovery).toContain("FOR UPDATE");
    expect(discovery).toContain("DISCOVERY_ALREADY_RUNNING");
    const schema = read("src/db/schema.ts");
    expect(schema).toContain("discovery_sessions_active_agent_unique");
    expect(schema).toContain("print_jobs_tenant_idempotency_unique");
    expect(schema).toContain("tenant_users_single_owner_idx");

    const printService = read("src/lib/print-job-service.ts");
    expect(printService).toContain("print_jobs:idempotency:");
    expect(printService).toContain("WHERE tenant_id = ${tenantId}");
    expect(printService).toContain("idempotency_key = ${effectiveIdempotencyKey}");
    expect(printService).toContain("status IN ('queued', 'claimed', 'printing')");
    expect(printService).toContain("const escapedReprintId = reprintOfJobId.replace");
    expect(printService).toContain('.replace(/%/g, "\\\\%")');
    expect(printService).toContain('.replace(/_/g, "\\\\_")');
    expect(printService).toContain("gw-reprint:${escapedReprintId}:%");
    expect(printService).toContain("ESCAPE '\\\\'");

    const printRoute = read("src/app/api/print/jobs/route.ts");
    expect(printRoute).not.toContain("eq(printJobs.apiKeyId, odoo.id), eq(printJobs.idempotencyKey");
    expect(printRoute).toContain("eq(printJobs.tenantId, odoo.tenantId), eq(printJobs.idempotencyKey");
    expect(printRoute).toContain("eq(printJobs.id, id), eq(printJobs.tenantId, odoo.tenantId), eq(printJobs.apiKeyId, odoo.id)");

    const batchStatus = read("src/app/api/print/jobs/batch-status/route.ts");
    expect(batchStatus).toContain("eq(printJobs.tenantId, odoo.tenantId)");
    expect(batchStatus).toContain("eq(printJobs.apiKeyId, odoo.id)");

    const auth = read("src/lib/manager-auth.ts");
    expect(auth).toContain("passwordHash: true");
    expect(auth).toContain("eq(users.passwordHash, legacyHash)");
    expect(auth).toContain("if (!row || !row.emailVerifiedAt) return null;");
    expect(auth).toContain("if (upgradedRows.length !== 1) return null;");

    // The cancel/resume operation protocol (persistent claim fence, Stripe
    // idempotency, guarded finalization) lives once in the shared billing
    // operation module; the routes are thin per-operation descriptors.
    const billingOp = read("src/lib/billing-operation.ts");
    expect(billingOp).toContain("FROM tenants");
    expect(billingOp).toContain("FOR UPDATE");
    expect(billingOp).toContain("FROM tenant_subscriptions");
    expect(billingOp).toContain("stripeRequest(");
    expect(billingOp).toContain("billingOperationId");
    expect(billingOp).toContain('`billing-${operation.type}-${operationId}`');
    for (const [path, type] of [
      ["src/app/api/billing/cancel/route.ts", "cancel"],
      ["src/app/api/billing/resume/route.ts", "resume"],
    ] as const) {
      const billingRoute = read(path);
      expect(billingRoute).toContain("runBillingOperation(");
      expect(billingRoute).toContain(`type: "${type}"`);
      expect(billingRoute).toContain(`cancel_at_period_end: "${type === "cancel" ? "true" : "false"}"`);
      expect(billingRoute).toContain(`cancelAtPeriodEnd: ${type === "cancel"}`);
    }
  });

});
