import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

describe("SaaS control-plane contracts", () => {
  it("binds manager sessions to a human identity and tenant role", () => {
    const schema = read("src/db/schema.ts");
    const auth = read("src/lib/manager-auth.ts");
    expect(schema).toContain('userId: text("user_id").references(() => users.id)');
    expect(schema).toContain('role: text("role").notNull().default("owner")');
    expect(auth).toContain("tenantUsers.userId");
    expect(auth).toContain("membership.role !== claims.role");
    expect(read("src/lib/workspace-session-security.ts")).toContain("m.role=r.role");
  });

  it("centralizes manager permissions", () => {
    const policy = read("src/lib/authorization.ts");
    expect(policy).toContain("hasManagerPermission");
    expect(policy).toContain('"printers.manage"');
    expect(policy).toContain('"billing.manage"');
  });

  it("keeps durable audit data tenant-bound and secret-sanitized", () => {
    const schema = read("src/db/schema.ts");
    const audit = read("src/lib/audit.ts");
    expect(schema).toContain('export const auditEvents = pgTable("audit_events"');
    expect(schema).toContain('tenantId: text("tenant_id").references(() => tenants.id).notNull()');
    expect(audit).toContain("SECRET_KEYS");
    expect(audit).toContain('"[redacted]"');
  });

  it("implements subscription-driven tenant job admission without inventing a default plan", () => {
    const service = read("src/lib/entitlements.ts");
    expect(service).toContain("tenant_subscriptions");
    expect(service).toContain("max_jobs_per_minute");
    expect(service).toContain("max_concurrent_jobs");
    // Retired license-only control plane deleted src/lib/print-job-service.ts.
    if (existsSync(join(root, "src/lib/print-job-service.ts"))) {
      const job = read("src/lib/print-job-service.ts");
      expect(job).toContain("enforceTenantJobEntitlements");
    }
  });

});
