import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (p: string) => readFileSync(p, "utf8");

describe("request lifecycle is traceable from customer to Platform Admin", () => {
  it("does not claim free credit for resubmitted jobs in the marketing page", () => {
    const pricing = source("src/app/pricing/page.tsx");
    const copy = source("src/i18n/messages/v4-onboarding.ts");
    expect(pricing).not.toContain("v4.pricing.retryPolicy");
    expect(pricing).not.toContain("v4.onboarding.monthlyReset");
    expect(pricing).not.toContain("v4.pricing.eyebrow");
    expect(copy).not.toContain('"v4.pricing.retryPolicy"');
  });
  it("shows the pending queue and requested plan, duration, quota and requester", () => {
    const page = source("src/app/platform/subscription-requests/page.tsx");
    const api = source("src/app/api/platform/subscription-requests/route.ts");
    for (const part of ["planName", "planMonthlyQuota", "pendingCount", "requester_email", "request.term", "request.id"]) {
      expect(page).toContain(part);
    }
    expect(page).toContain('?request=${encodeURIComponent(request.id)}');
    expect(api).toContain('AS "planMonthlyQuota"');
    expect(api).toContain("pendingCount");
    expect(api).toContain("LIMIT 101 OFFSET");
    expect(api).toContain("requirePlatformOwner(req)");
  });
  it("deep links to the exact request, and the editor seeds approval from customer intent", () => {
    const detail = source("src/app/platform/tenants/[id]/page.tsx");
    const editor = source("src/components/platform/SubscriptionEditor.tsx");
    expect(detail).toContain('get("request")');
    expect(detail).toContain('setTab("subscriptions")');
    expect(detail).toContain("selectedRequest?.status==='pending'");
    expect(detail).toContain("request={linkedRequest}");
    expect(editor).toContain("request?.planId");
    expect(editor).toContain("request.term as Term");
    expect(editor).toContain("allowRequestChanges");
    expect(editor).toContain("requestId:request.id");
    expect(editor).not.toContain("setApprove(");
  });
  it("rejects mismatched approvals and different pending customer requests", () => {
    const approval = source("src/lib/manual-subscriptions.ts");
    const customer = source("src/app/api/subscription-requests/route.ts");
    expect(approval).toContain("input.planId !== requested.planId");
    expect(approval).toContain("input.term !== requested.term");
    expect(approval).toContain("input.monthlyQuota !== requestedQuota");
    expect(approval).toContain("SUBSCRIPTION_REQUEST_TERMS_MISMATCH");
    expect(approval).toContain("approvalModified:requestApproval?.modified");
    expect(approval).toContain("approvedTerm:input.term");
    expect(approval).toContain("status='pending' FOR UPDATE");
    expect(customer).toContain("SUBSCRIPTION_REQUEST_ALREADY_PENDING");
    expect(customer).toContain('requireManagerActorInTransaction(tx,actor,"billing.read")');
  });
  it("uses actionable, non-duplicative overview icons", () => {
    const dashboard = source("src/app/platform/dashboard/page.tsx");
    const metrics = source("src/components/platform/ManualAdmin.tsx");
    expect(metrics).toContain("icon?:React.ReactNode");
    expect(dashboard).toContain('icon={<ClipboardList');
    expect(dashboard).toContain('href="/platform/subscription-requests"');
    expect(dashboard).not.toContain("a('calendar')");
    expect(dashboard).not.toContain("a('advanced')");
  });
});
