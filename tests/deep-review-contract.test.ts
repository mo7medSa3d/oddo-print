import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("deep production review contracts", () => {
  it("keeps diagnostic test-print retry arithmetic on the database clock", () => {
    const source = read("src/app/api/printers/[id]/test-print/route.ts");
    expect(source).toContain("databaseNowMs");
    expect(source).not.toContain("periodEnd.getTime() - Date.now()");
    expect(source).toContain('headers.set("Retry-After", "60")');
  });

  it("keeps certification expiry, idempotency bucket, and heartbeat age on the database clock", () => {
    const source = read("src/app/api/printers/[id]/certify/route.ts");
    expect(source).toContain("const certificationNowMs = await databaseNowMs();");
    expect(source).toContain("Math.floor(certificationNowMs / 60000)");
    expect(source).toContain("new Date(certificationNowMs + 5 * 60 * 1000)");
    expect(source).toContain("const age = certificationNowMs - new Date(agent.lastSeenAt).getTime()");
    expect(source).not.toContain("Math.floor(Date.now() / 60000)");
    expect(source).not.toContain("new Date(Date.now() + 5 * 60 * 1000)");
    expect(source).not.toContain("const age = Date.now() -");
  });

  it("keeps time-bound retry responses on the database clock", () => {
    const reprint = read("src/app/api/jobs/[id]/reprint/route.ts");
    expect(reprint).toContain("databaseNowMs");
    expect(reprint).not.toMatch(/periodEnd\.getTime\(\) - Date\.now\(\)/);
  });

  it("uses PostgreSQL epoch time for shared authentication rate-limit state", () => {
    const source = read("src/lib/auth-rate-limit.ts");
    expect((source.match(/SELECT EXTRACT\(EPOCH FROM clock_timestamp\(\)\) \* 1000 AS now_ms/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(source).toContain("clock_timestamp() - interval '24 hours'");
    expect(source).toContain("Database clock is unavailable");
    expect(source).not.toMatch(/function reserveBucketAttempt[\s\S]{0,700}const now = new Date\(\)/);
    expect(source).not.toMatch(/function reserveAuthAttempt[\s\S]{0,900}const now = new Date\(\)/);
  });

  it("uses PostgreSQL time directly for Odoo API-key rotation grace", () => {
    const source = read("src/lib/odoo-auth.ts");
    expect(source).toContain("clock_timestamp()");
    expect(source).not.toContain("gatewayNow()");
    expect(source).not.toContain("Date.now()");
  });

  it("keeps Odoo API-key lifecycle timestamps on the database clock", () => {
    const keys = read("src/app/api/odoo/keys/route.ts");
    const rotate = read("src/app/api/odoo/keys/[id]/rotate/route.ts");
    expect(keys).toContain("rotationState: sql<");
    expect(keys).toContain("clock_timestamp()");
    expect(keys).toContain("lte(apiKeys.readOnlyUntil, sql`clock_timestamp()`)");
    expect(keys).toContain("revokedAt: sql`clock_timestamp()`");
    expect(keys).not.toContain("const now = gatewayNowMs()");
    expect(keys).not.toContain("revokedAt: new Date()");
    expect(rotate).toContain("SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS now_ms");
    expect(rotate).not.toContain("const rotatedAt = new Date();");
  });

  it("keeps billing and cleanup lifecycle timestamps on the database clock", () => {
    const checkout = read("src/app/api/billing/checkout/route.ts");
    const webhook = read("src/app/api/billing/webhook/route.ts");
    const jobs = read("src/app/api/jobs/route.ts");
    expect(checkout).not.toContain("updatedAt: new Date()");
    expect(webhook).not.toContain("processedAt: new Date()");
    expect(webhook).not.toContain("updatedAt: new Date()");
    expect(webhook).toContain("processedAt: sql`clock_timestamp()`");
    expect(webhook).toContain("updatedAt: sql`clock_timestamp()`");
    expect(jobs).toContain("const databaseNow = await databaseNowMs()");
    expect(jobs).not.toContain("before.getTime() > Date.now()");
  });

  it("redacts claim credentials before timeline persistence and logging", () => {
    const timeline = read("src/lib/job-timeline.ts");
    const log = read("src/lib/log.ts");
    expect(timeline).toContain("createHash");
    expect(timeline).toContain("redactClaimId(input.claimId ?? ctx?.claimId)");
    expect(timeline).not.toContain("claimId: input.claimId ?? ctx?.claimId");
    expect(log).toContain("redactClaimId(ctx.claimId)");
  });

  it("keeps WebSocket global socket accounting exact when evicting a socket", () => {
    const source = read("src/server/ws.ts");
    expect(source).toContain("socketCounted?: boolean;");
    expect(source).toContain("function uncountAgentSocket(ws: AgentSocket): void");
    expect(source).toContain("uncountAgentSocket(oldest)");
    expect(source).toContain("uncountAgentSocket(target)");
    expect(source).toContain("uncountAgentSocket(ws);");
  });

  it("keeps Manager session lifetime on PostgreSQL time", () => {
    const manager = read("src/lib/manager-auth.ts");
    const tx = read("src/lib/manager-session-tx.ts");
    expect(manager).toContain("databaseNowMs");
    expect(manager).toContain("clock_timestamp()");
    expect(manager).toContain("EXTRACT(EPOCH FROM clock_timestamp())");
    expect(manager).not.toContain("gatewayNowMs()");
    expect(manager).not.toContain("refreshClockSkew()");
    expect(tx).toContain("SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS now_ms");
  });

  it("requires printer freshness and active billing entitlement at every delivery boundary", async () => {
    const availability = await import("../src/lib/agent-availability");
    const now = new Date("2026-09-24T00:00:00.000Z");
    const fresh = new Date(now.getTime() - 30_000);
    const stale = new Date(now.getTime() - 120_000);

    expect(availability.isPrinterObservationFresh(fresh, now)).toBe(true);
    expect(availability.isPrinterObservationFresh(stale, now)).toBe(false);
    expect(
      availability.getEffectivePrinterStatus(
        { lifecycle: "active", status: "online", lastSeenAt: fresh },
        { lifecycle: "active", status: "online", lastSeenAt: fresh },
        now,
      ),
    ).toBe("online");
    expect(
      availability.getEffectivePrinterStatus(
        { lifecycle: "active", status: "online", lastSeenAt: stale },
        { lifecycle: "active", status: "online", lastSeenAt: fresh },
        now,
      ),
    ).toBe("offline");
    expect(
      availability.getEffectivePrinterStatus(
        { lifecycle: "active", status: "online" },
        { lifecycle: "active", status: "online", lastSeenAt: fresh },
        now,
      ),
    ).toBe("offline");

    const wsClaim = read("src/lib/job-delivery.ts");
    const pollClaim = read("src/app/api/agent/jobs/route.ts");
    for (const source of [wsClaim, pollClaim]) {
      expect(source).toContain("observed_desired_revision >= pr.desired_revision");
      expect(source).toContain("applied_desired_revision >= pr.desired_revision");
      expect(source).toContain("printerStaleThresholdSeconds");
      expect(source).toContain("pr.last_seen_at IS NOT NULL");
      expect(source).toContain("pr.last_seen_at > now() - make_interval");
      expect(source).toContain("FROM tenant_subscriptions ts");
      expect(source).toContain("ts.status IN ('trialing', 'active', 'past_due')");
      expect(source).toContain("ts.status = 'past_due'");
      expect(source).toContain("COALESCE(ts.entitlement_blocked, false) = false");
      expect(source).toContain("ts.current_period_end > now()");
    }

    // The poll candidate CTEs must filter invalid rows before LIMIT is applied;
    // otherwise a page full of stale/revoked candidates can starve healthy work.
    expect((pollClaim.match(/WITH stale_candidates|queued_candidates|claimable/g) ?? []).length).toBe(3);
    expect((pollClaim.match(/pr\.last_seen_at > now\(\) - make_interval/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("keeps Agent heartbeat as observed telemetry and Manager-owned desired state", async () => {
    const heartbeat = read("src/app/api/agent/heartbeat/route.ts");
    expect(heartbeat).toContain("lastSeenAt: sql`now()`");
    expect(heartbeat).toContain('eq(printers.managementSource, "manager")');
    expect(heartbeat).toContain("appliedDesiredRevision");
    expect(heartbeat).toContain("observedDesiredRevision");
    expect(heartbeat).toContain("gateway_owned_deletion_pending");
  });

  it("keeps the Odoo printer inventory status tied to its observed freshness", () => {
    const source = read("src/app/api/odoo/printers/route.ts");
    expect(source).toContain("lastSeenAt: printers.lastSeenAt");
    expect(source).toContain("lastSeenAt: row.lastSeenAt");
    expect(source).toContain("getEffectivePrinterStatus(");
  });

  it("redacts explicit claim correlation fields in the logger", () => {
    const source = read("src/lib/log.ts");
    expect(source).toContain('if (key === "claimId" || key === "claim_id")');
    expect(source).toContain("redactClaimId(value)");
  });

  it("scrubs legacy raw UUID claim ids from the timeline during migration", () => {
    const source = read("drizzle/0069_redact_legacy_claim_ids.sql");
    expect(source).toContain("UPDATE job_events");
    expect(source).toContain("md5(claim_id)");
    expect(source).toContain("WHERE claim_id ~");
  });

  it("keeps Odoo configuration and billing-operation timestamps on PostgreSQL", () => {
    const configuration = read("src/app/api/odoo/configuration/route.ts");
    const billing = read("src/lib/billing-operation.ts");
    expect(configuration).toContain("odooEnabledUpdatedAt: sql`clock_timestamp()`");
    expect(configuration).not.toContain("const now = new Date()");
    expect(billing).toContain("updatedAt: sql`clock_timestamp()`");
    expect(billing).not.toContain("updatedAt: new Date()");
  });

  it("uses database epoch time when re-enabling an Agent and minting its pairing expiry", () => {
    const source = read("src/lib/agent-lifecycle.ts");
    expect(source).toContain("SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS now_ms");
    expect(source).toContain("pairingCodeExpiresAt: pairingCode ? new Date(now.getTime() + 10 * 60 * 1000)");
    expect(source).not.toContain("const now = new Date()");
  });

  it("uses monotonic clocks for in-process WebSocket rate limiting", () => {
    const source = read("src/server/ws.ts");
    const upgradeSource = read("src/lib/ws-rate-limit.ts");
    expect(source).toContain('import { performance } from "node:perf_hooks";');
    expect(source).toContain("private lastRefillMs = performance.now()");
    expect(source).toContain("const now = performance.now();");
    expect(source).toContain("function pruneIdleWsBuckets(nowMs = performance.now())");
    expect(upgradeSource).toContain('import { performance } from "node:perf_hooks";');
    expect(upgradeSource).toContain("now = performance.now()");
    expect(upgradeSource).toContain("SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS now_ms");
    expect(upgradeSource).not.toMatch(/reserveWsUpgradeAttempt[\s\S]{0,700}const now = new Date\(\)/);
  });

  it("keeps Odoo Company/Branch agent scope fail-closed at the model boundary", () => {
    const source = read("odoo_addons/print_gateway/models/runtime_assignment.py");
    expect(source).toContain('("branch_id", "=", branch.id)');
    expect(source).toContain('("branch_id", "=", False)');
    expect(source).toContain('record.branch_id.parent_id != record.company_id');
    expect(source).toContain('if branch.parent_id != company:');
    expect(source).toContain('record.company_id.parent_id');
    expect(source).toContain("self.assigned_agent_ids(company, branch)");
  });

  it("submits explicit Odoo retries only after their durable row commits", () => {
    const source = read("odoo_addons/print_gateway/models/print_job.py");
    const retryStart = source.indexOf("    def action_retry(self):");
    const forceStart = source.indexOf("    def action_force_reprint(self):");
    const cronStart = source.indexOf("    def _require_cron_runner(self):");
    expect(retryStart).toBeGreaterThanOrEqual(0);
    expect(forceStart).toBeGreaterThan(retryStart);
    expect(cronStart).toBeGreaterThan(forceStart);

    const retrySection = source.slice(retryStart, forceStart);
    const forceSection = source.slice(forceStart, cronStart);
    expect(retrySection).toContain("self._schedule_postcommit_submission(retry.id)");
    expect(forceSection).toContain("self._schedule_postcommit_submission(retry.id)");
    expect(retrySection).not.toContain("_print_gateway_submission_precommit");
    expect(forceSection).not.toContain("_print_gateway_submission_precommit");
    expect(source).toContain("def _schedule_postcommit_submission(self, job_id):");
    expect(source).toContain("the durable outbox row remains queued for cron recovery");
  });
});


  it("agent pairing and re-enable enforce the same billing policy as Odoo discovery", () => {
    const register = read("src/app/api/agent/register/route.ts");
    const lifecycle = read("src/lib/agent-lifecycle.ts");
    const entitlements = read("src/lib/entitlements.ts");
    const odooAgents = read("src/app/api/odoo/agents/route.ts");
    expect(odooAgents).toContain("active subscription is required before pairing agents");
    expect(register).toContain("SUBSCRIPTION_REQUIRED");
    expect(register).toContain("entitlement_blocked");
    expect(lifecycle).toContain("requireTenantBillingAccess(tx, tenantId)");
    expect(entitlements).toContain("requireTenantBillingAccess");
    expect(entitlements).toContain("status IN ('trialing', 'active', 'past_due')");
    expect(entitlements).toContain("current_period_end > clock_timestamp()");
    expect(entitlements).toContain("COALESCE(entitlement_blocked, false) = false");
    expect(entitlements).toContain("TenantSubscriptionRequiredError");
  });


  it("maps Agent re-enable billing rejection to HTTP 403 instead of a generic 500", () => {
    const route = read("src/app/api/agents/[id]/route.ts");
    expect(route).toContain("isTenantBillingError");
    expect(route).toContain("status: 403");
    expect(route).toContain("error.code");
  });
